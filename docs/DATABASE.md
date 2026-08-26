# DATABASE — Supabase V1

## General conventions
- PostgreSQL via Supabase.
- UUID primary keys unless otherwise noted.
- `created_at` / `updated_at` use `timestamptz` with sensible defaults.
- Use database constraints for invariants, not only UI validation.
- Enable RLS on all tables containing user/business data.

## Enums
Suggested enums:
- `shop_status`: `draft`, `pending_review`, `published`, `suspended`, `rejected`
- `shop_member_role`: `owner`, `manager`, `editor`
- `shop_image_type`: `logo`, `cover`, `gallery`
- `verification_type`: `domain`, `business`, `identity`, `website_security`
- `verification_status`: `pending`, `verified`, `failed`, `expired`
- `discovery_source`: `home`, `explore`, `search`, `favorites`, `direct`
- `report_reason`: `scam_suspected`, `counterfeit`, `website_unavailable`, `misleading_information`, `other`
- `report_status`: `open`, `reviewing`, `resolved`, `dismissed`
- `analysis_status`: `queued`, `running`, `completed`, `failed`

## Tables
### profiles
- `id uuid primary key references auth.users(id) on delete cascade`
- `username text`
- `avatar_path text null`
- `country_code text null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Do not duplicate auth email unless a clear product need appears.

### shops
- `id uuid primary key default gen_random_uuid()`
- `name text not null`
- `slug text unique not null`
- `website_url text unique not null`
- `short_description text null`
- `long_description text null`
- `country_code text null`
- `city text null`
- `price_level smallint null check (price_level between 1 and 4)`
- `is_independent boolean null`
- `status shop_status not null default 'draft'`
- `created_by uuid null references profiles(id)`
- `published_at timestamptz null`
- timestamps

Do not store a manually editable `verified boolean`. Overall verification is derived from verification records/rules.

### shop_members
- `shop_id uuid references shops(id) on delete cascade`
- `user_id uuid references profiles(id) on delete cascade`
- `role shop_member_role not null`
- `created_at timestamptz not null default now()`
- primary key `(shop_id, user_id)`

### categories
- `id uuid primary key default gen_random_uuid()`
- `name text not null`
- `slug text unique not null`
- `parent_id uuid null references categories(id)`
- `position integer not null default 0`
- `is_active boolean not null default true`

### shop_categories
- `shop_id uuid references shops(id) on delete cascade`
- `category_id uuid references categories(id) on delete cascade`
- primary key `(shop_id, category_id)`

### tags
- `id uuid primary key default gen_random_uuid()`
- `name text not null`
- `slug text unique not null`

### shop_tags
- `shop_id uuid references shops(id) on delete cascade`
- `tag_id uuid references tags(id) on delete cascade`
- primary key `(shop_id, tag_id)`

Application/domain logic should limit a shop to roughly five primary tags in V1.

### shop_images
- `id uuid primary key default gen_random_uuid()`
- `shop_id uuid references shops(id) on delete cascade`
- `storage_path text not null`
- `image_type shop_image_type not null`
- `position integer not null default 0`
- `alt_text text null`
- `created_at timestamptz not null default now()`

Prefer Storage paths over duplicated permanent public URLs.

### favorites
- `user_id uuid references profiles(id) on delete cascade`
- `shop_id uuid references shops(id) on delete cascade`
- `created_at timestamptz not null default now()`
- primary key `(user_id, shop_id)`

### shop_views
- `id bigint generated always as identity primary key`
- `shop_id uuid references shops(id)`
- `user_id uuid null references profiles(id)`
- `source discovery_source not null`
- `session_id uuid null`
- `created_at timestamptz not null default now()`

### outbound_clicks
- same general shape as `shop_views`
- records click on merchant-site CTA

### shop_verifications
- `id uuid primary key default gen_random_uuid()`
- `shop_id uuid references shops(id) on delete cascade`
- `verification_type verification_type not null`
- `status verification_status not null default 'pending'`
- `provider text null`
- `metadata jsonb not null default '{}'::jsonb`
- `verified_at timestamptz null`
- `expires_at timestamptz null`
- timestamps

Consider uniqueness by `(shop_id, verification_type)` if only the current verification record is stored; otherwise retain history and expose a current-status view.

### shop_reports
- `id uuid primary key default gen_random_uuid()`
- `shop_id uuid references shops(id)`
- `user_id uuid references profiles(id)`
- `reason report_reason not null`
- `description text null`
- `status report_status not null default 'open'`
- `created_at timestamptz not null default now()`
- `resolved_at timestamptz null`

### user_preferences
- `user_id uuid primary key references profiles(id) on delete cascade`
- `country_code text null`
- `max_price_level smallint null check (max_price_level between 1 and 4)`
- timestamps

### user_interest_categories
- `user_id uuid references profiles(id) on delete cascade`
- `category_id uuid references categories(id) on delete cascade`
- primary key `(user_id, category_id)`

### shop_analysis_runs
- `id uuid primary key default gen_random_uuid()`
- `shop_id uuid references shops(id) on delete cascade`
- `requested_by uuid references profiles(id)`
- `source_url text not null`
- `status analysis_status not null default 'queued'`
- `raw_extracted_data jsonb null`
- `ai_result jsonb null`
- `error_message text null`
- `created_at timestamptz not null default now()`
- `completed_at timestamptz null`

## Search indexes
At minimum plan indexes for:
- `shops(status)`
- `shops(published_at)`
- `shops(country_code)`
- `shop_categories(category_id)`
- `shop_tags(tag_id)`
- `shop_views(shop_id, created_at)`
- `outbound_clicks(shop_id, created_at)`
- PostgreSQL full-text search over shop name + descriptions.

## RLS policy intent
### Public
- Read only public data belonging to `published` shops.
- Do not expose sensitive verification metadata, moderation details, analysis raw data, or private membership data.

### Authenticated user
- Read/update own profile/preferences.
- CRUD only own favorites.
- Create own reports; do not read other users' private reports.

### Shop member
- May read owned/managed shop even when draft/pending.
- Editor: content edits only.
- Manager: content + allowed management operations.
- Owner: membership management and full merchant-side shop management.
- No role may self-grant privileged verification or publication status through client operations.

### Backend/admin
- Controls verification state.
- Controls moderation/publishing/suspension.
- May access analysis logs and sensitive verification metadata as needed.

## Storage intent
Buckets/policies should separate public shop media from private/sensitive verification material. Never expose identity/business verification documents publicly.
