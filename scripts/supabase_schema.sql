-- =============================================================================
-- Plataforma Íris — esquema no Supabase (Postgres)
-- Idempotente: pode ser executado várias vezes. Aplicado por scripts/setup_supabase.py
-- (ou cole no SQL Editor do painel do Supabase).
--
-- Segurança: todas as tabelas têm RLS. Com a chave publicável, cada professor autenticado
-- só lê/grava as próprias linhas (auth.uid()). O papel (professor/pesquisador) não pode ser
-- alterado pelo próprio usuário — só pelo SQL Editor / service role.
-- =============================================================================

-- ---------------------------------------------------------------- usuarios
-- Perfil do professor; a conta (e-mail/senha) fica em auth.users, gerida pelo Supabase Auth.
create table if not exists public.usuarios (
    id             uuid primary key references auth.users (id) on delete cascade,
    nome           text not null default '' check (char_length(nome) <= 120),
    email          text not null unique,
    papel          text not null default 'professor' check (papel in ('professor', 'pesquisador')),
    criado_em      timestamptz not null default now(),
    ultimo_acesso  timestamptz
);

alter table public.usuarios enable row level security;

drop policy if exists "usuarios: ler o proprio perfil" on public.usuarios;
create policy "usuarios: ler o proprio perfil" on public.usuarios
    for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "usuarios: atualizar o proprio perfil" on public.usuarios;
create policy "usuarios: atualizar o proprio perfil" on public.usuarios
    for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Só nome e último acesso são editáveis pelo usuário (impede promover-se a pesquisador).
revoke all on public.usuarios from anon;
revoke insert, update, delete on public.usuarios from authenticated;
grant select on public.usuarios to authenticated;
grant update (nome, ultimo_acesso) on public.usuarios to authenticated;

-- Perfil criado automaticamente no cadastro (nome vem de user_metadata.nome).
create or replace function public.iris_criar_perfil()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.usuarios (id, nome, email)
    values (
        new.id,
        left(coalesce(new.raw_user_meta_data ->> 'nome', split_part(new.email, '@', 1)), 120),
        lower(new.email)
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists iris_ao_criar_usuario on auth.users;
create trigger iris_ao_criar_usuario
    after insert on auth.users
    for each row execute function public.iris_criar_perfil();

-- E-mail trocado no Supabase Auth → perfil acompanha.
create or replace function public.iris_sincronizar_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.usuarios set email = lower(new.email) where id = new.id;
    return new;
end;
$$;

drop trigger if exists iris_ao_mudar_email on auth.users;
create trigger iris_ao_mudar_email
    after update of email on auth.users
    for each row when (old.email is distinct from new.email)
    execute function public.iris_sincronizar_email();

-- Contas que já existiam antes deste script.
insert into public.usuarios (id, nome, email)
select u.id, left(coalesce(u.raw_user_meta_data ->> 'nome', split_part(u.email, '@', 1)), 120), lower(u.email)
  from auth.users u
 where u.email is not null
on conflict (id) do nothing;

-- ---------------------------------------------------------------- relatorios_aee
-- Relatórios BNCC & AEE emitidos. DADO PESSOAL SENSÍVEL quando traz o aluno (LGPD art. 11 e 14):
-- prefira iniciais/código; acesso restrito ao professor dono pela RLS.
create table if not exists public.relatorios_aee (
    id            uuid primary key default gen_random_uuid(),
    professor_id  uuid not null default auth.uid() references public.usuarios (id) on delete cascade,
    titulo        text not null check (char_length(titulo) between 1 and 200),
    perfil        text not null default '' check (perfil ~ '^[A-Z0-9_]{0,40}$'),
    disciplina    text not null default '' check (char_length(disciplina) <= 200),
    turma         text not null default '' check (char_length(turma) <= 200),
    aluno         text not null default '' check (char_length(aluno) <= 200),
    dados         jsonb not null default '{}'::jsonb,   -- relatório normalizado (habilidades BNCC, justificativas…)
    observacoes   text not null default '' check (char_length(observacoes) <= 2000),
    criado_em     timestamptz not null default now()
);
create index if not exists ix_relatorios_aee_professor on public.relatorios_aee (professor_id, criado_em desc);

alter table public.relatorios_aee enable row level security;

drop policy if exists "relatorios_aee: dono" on public.relatorios_aee;
create policy "relatorios_aee: dono" on public.relatorios_aee
    for all to authenticated
    using ((select auth.uid()) = professor_id)
    with check ((select auth.uid()) = professor_id);

revoke all on public.relatorios_aee from anon;
grant select, insert, update, delete on public.relatorios_aee to authenticated;

-- ---------------------------------------------------------------- eventos_acessibilidade
-- Uso dos recursos de acessibilidade (painel "Histórico e Trajetória AEE"). Anônimo por construção:
-- sem aluno e sem texto livre — os valores aceitos espelham app/services/aee_analytics_service.py.
create table if not exists public.eventos_acessibilidade (
    id             bigint generated always as identity primary key,
    professor_id   uuid not null default auth.uid() references public.usuarios (id) on delete cascade,
    perfil         text not null default '' check (perfil ~ '^[A-Z0-9_]{0,40}$'),
    recurso        text not null check (recurso in (
                       'contraste', 'tipografia', 'fonte', 'entrelinhas', 'velocidade_voz', 'leitura_voz',
                       'sonificacao', 'regua', 'foco_minimo', 'pausa', 'mapa_simples', 'termos_libras',
                       'vlibras', 'exportacao')),
    valor          text not null default '' check (valor ~ '^[a-z0-9.\-]{0,20}$'),
    data_registro  timestamptz not null default now()
);
create index if not exists ix_eventos_professor_data on public.eventos_acessibilidade (professor_id, data_registro);

alter table public.eventos_acessibilidade enable row level security;

drop policy if exists "eventos: ler os proprios" on public.eventos_acessibilidade;
create policy "eventos: ler os proprios" on public.eventos_acessibilidade
    for select to authenticated using ((select auth.uid()) = professor_id);

drop policy if exists "eventos: registrar os proprios" on public.eventos_acessibilidade;
create policy "eventos: registrar os proprios" on public.eventos_acessibilidade
    for insert to authenticated with check ((select auth.uid()) = professor_id);

drop policy if exists "eventos: apagar os proprios" on public.eventos_acessibilidade;
create policy "eventos: apagar os proprios" on public.eventos_acessibilidade
    for delete to authenticated using ((select auth.uid()) = professor_id);

revoke all on public.eventos_acessibilidade from anon;
grant select, insert, delete on public.eventos_acessibilidade to authenticated;
