-- Semantic search foundation.
--
-- Kept in its own migration so a problem enabling pgvector cannot block the
-- core schema, and so the dimension can be fixed later without touching it.
--
-- IMPORTANT — the embedding dimension is deliberately NOT fixed.
--
-- No embedding model has been chosen, and the dimension is a property of the
-- model (768, 1024, 1536, 3072 … depending on vendor and version). Picking one
-- now would either silently lock the choice or force a destructive migration
-- later. pgvector allows an unconstrained `vector` column, which accepts any
-- dimension, so the tables below are usable the moment a model is selected.
--
-- The cost of that decision, stated plainly: an unconstrained vector column
-- CANNOT carry an HNSW or IVFFlat index. Similarity search over it works but
-- is a sequential scan, which is fine for a few thousand shops and not fine
-- beyond that. Once the model is chosen, a follow-up migration must:
--
--   1. alter table public.shop_embeddings
--        alter column embedding type extensions.vector(<dim>);
--   2. create index … using hnsw (embedding extensions.vector_cosine_ops);
--   3. the same for public.help_article_embeddings.
--
-- Until then `dimensions` records what was actually stored, so the follow-up
-- migration can verify every row agrees before constraining the type.

create extension if not exists vector with schema extensions;

create table public.shop_embeddings (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  -- Unconstrained on purpose. See the note above.
  embedding extensions.vector not null,
  dimensions integer not null check (dimensions > 0),
  -- Provider-neutral provenance: nothing here names a vendor.
  embedding_model text not null,
  embedding_version text,
  -- What the vector was computed from, so stale embeddings are detectable
  -- and unchanged content is not re-embedded.
  source_hash text,
  source_kind text not null default 'shop_profile'
    check (source_kind in ('shop_profile', 'shop_description', 'shop_ai_summary')),
  created_at timestamptz not null default now()
);

comment on table public.shop_embeddings is
  'Semantic vectors for shops. One row per (shop, model, source_kind) so a '
  'model can be swapped or A/B tested without deleting the previous vectors.';

create unique index shop_embeddings_unique_idx
  on public.shop_embeddings (shop_id, embedding_model, source_kind);
create index shop_embeddings_shop_id_idx on public.shop_embeddings (shop_id);
create index shop_embeddings_model_idx on public.shop_embeddings (embedding_model);

create table public.help_article_embeddings (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.help_articles (id) on delete cascade,
  -- Long articles are chunked; one row per chunk.
  chunk_index integer not null default 0 check (chunk_index >= 0),
  chunk_text text not null,
  embedding extensions.vector not null,
  dimensions integer not null check (dimensions > 0),
  embedding_model text not null,
  embedding_version text,
  source_hash text,
  created_at timestamptz not null default now()
);

comment on table public.help_article_embeddings is
  'RAG corpus for the future help assistant, so it answers from Shop '
  'Discovery''s own knowledge rather than inventing product rules.';

create unique index help_article_embeddings_unique_idx
  on public.help_article_embeddings (article_id, chunk_index, embedding_model);

-- Embeddings are internal. No client reads or writes them: similarity search
-- runs server-side and returns shops, never vectors.
revoke all on public.shop_embeddings from anon, authenticated;
revoke all on public.help_article_embeddings from anon, authenticated;

alter table public.shop_embeddings enable row level security;
alter table public.help_article_embeddings enable row level security;
