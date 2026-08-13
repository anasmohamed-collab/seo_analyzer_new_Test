\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif
\encoding UTF8

-- SEO Analyzer empty-database bootstrap: complete application schema + 45 projects.
-- Snapshot basis: 13 existing Production projects + 32 reviewed GSC creations.
-- This is NOT a historical Production database dump. audit_runs, audit_results,
-- seed_urls, and seo_analyses are created empty because their historical rows were
-- not exported from PostgreSQL and must not be fabricated.
--
-- Run only against the intentional new/empty database that the application will
-- use as DATABASE_URL. The script aborts if public already contains any table.
-- Default mode creates and validates everything transactionally, then ROLLBACKs.
-- COMMIT requires: psql ... -v apply=true -f PRODUCTION_FULL_BOOTSTRAP.sql

\if :apply
\echo 'APPLY MODE: empty database will receive the full schema and 45 projects.'
\else
\echo 'DRY-RUN MODE: full schema and data will be created, validated, and rolled back.'
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('seo-analyzer:empty-database-bootstrap:2026-08-13', 0));

DO $empty_database_guard$
DECLARE
  found_tables text;
BEGIN
  SELECT string_agg(table_name, ', ' ORDER BY table_name)
    INTO found_tables
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE';

  IF found_tables IS NOT NULL THEN
    RAISE EXCEPTION 'bootstrap requires an empty public schema; found table(s): %', found_tables;
  END IF;
END
$empty_database_guard$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.seo_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  status text NOT NULL,
  meta_title text,
  meta_description text,
  meta_h1 text,
  word_count integer DEFAULT 0,
  internal_links integer DEFAULT 0,
  external_links integer DEFAULT 0,
  language text,
  recommendations jsonb DEFAULT '[]'::jsonb,
  technical_seo jsonb DEFAULT '{}'::jsonb,
  content_analysis jsonb DEFAULT '{}'::jsonb,
  performance jsonb DEFAULT '{}'::jsonb,
  site_structure jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.sites (
  id text NOT NULL DEFAULT gen_random_uuid()::text,
  domain text NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  project_name text,
  website_url text,
  last_audit_at timestamptz,
  last_form_values jsonb,
  is_beta boolean NOT NULL DEFAULT false,
  CONSTRAINT sites_pkey PRIMARY KEY (id),
  CONSTRAINT sites_domain UNIQUE (domain)
);

CREATE TABLE public.seed_urls (
  id text NOT NULL DEFAULT gen_random_uuid()::text,
  site_id text NOT NULL,
  url text NOT NULL,
  page_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seed_urls_pkey PRIMARY KEY (id),
  CONSTRAINT seed_urls_site_fk FOREIGN KEY (site_id)
    REFERENCES public.sites (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE public.audit_runs (
  id text NOT NULL DEFAULT gen_random_uuid()::text,
  site_id text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  site_checks jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT audit_runs_pkey PRIMARY KEY (id),
  CONSTRAINT audit_runs_site_fk FOREIGN KEY (site_id)
    REFERENCES public.sites (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE public.audit_results (
  id text NOT NULL DEFAULT gen_random_uuid()::text,
  audit_run_id text NOT NULL,
  url text NOT NULL,
  data jsonb,
  status text,
  recommendations jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_results_pkey PRIMARY KEY (id),
  CONSTRAINT audit_results_run_fk FOREIGN KEY (audit_run_id)
    REFERENCES public.audit_runs (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX idx_sites_domain ON public.sites (domain);
CREATE INDEX idx_sites_last_audit_at ON public.sites (last_audit_at DESC NULLS LAST);
CREATE INDEX idx_seed_urls_site_id ON public.seed_urls (site_id);
CREATE INDEX idx_audit_runs_site_id ON public.audit_runs (site_id);
CREATE INDEX idx_audit_runs_status ON public.audit_runs (status);
CREATE INDEX idx_audit_runs_started_at ON public.audit_runs (started_at DESC);
CREATE INDEX idx_audit_results_run_id ON public.audit_results (audit_run_id);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_sites_updated_at
  BEFORE UPDATE ON public.sites
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.fn_sync_site_last_audit_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'COMPLETED'
     AND OLD.status IS DISTINCT FROM 'COMPLETED' THEN
    UPDATE public.sites
    SET last_audit_at = now()
    WHERE id = NEW.site_id;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_sync_site_last_audit_at
  AFTER UPDATE ON public.audit_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sync_site_last_audit_at();

ALTER TABLE public.seo_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seed_urls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read SEO analyses"
  ON public.seo_analyses FOR SELECT USING (true);

DO $authenticated_policy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE POLICY "Authenticated users can insert analyses"
      ON public.seo_analyses FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
END
$authenticated_policy$;

CREATE POLICY "Public can view sites" ON public.sites FOR SELECT USING (true);
CREATE POLICY "Public can create sites" ON public.sites FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can update sites" ON public.sites FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Public can delete sites" ON public.sites FOR DELETE USING (true);
CREATE POLICY "Public can view seed_urls" ON public.seed_urls FOR SELECT USING (true);
CREATE POLICY "Public can create seed_urls" ON public.seed_urls FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can update seed_urls" ON public.seed_urls FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Public can delete seed_urls" ON public.seed_urls FOR DELETE USING (true);
CREATE POLICY "Public can view audit_runs" ON public.audit_runs FOR SELECT USING (true);
CREATE POLICY "Public can create audit_runs" ON public.audit_runs FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can update audit_runs" ON public.audit_runs FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Public can delete audit_runs" ON public.audit_runs FOR DELETE USING (true);
CREATE POLICY "Public can view audit_results" ON public.audit_results FOR SELECT USING (true);
CREATE POLICY "Public can create audit_results" ON public.audit_results FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can update audit_results" ON public.audit_results FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Public can delete audit_results" ON public.audit_results FOR DELETE USING (true);

INSERT INTO public.schema_migrations (filename) VALUES
  ('20251202131039_create_seo_analysis_table.sql'),
  ('20251202131732_upgrade_seo_analysis_schema.sql'),
  ('20260305082415_create_audit_tables.sql'),
  ('20260325000000_add_performance_indexes.sql'),
  ('20260407000000_add_project_layer.sql'),
  ('20260413000000_add_last_form_values.sql'),
  ('20260720120000_normalize_legacy_site_domains.sql'),
  ('20260811000000_add_site_beta_classification.sql'),
  ('init.sql');

INSERT INTO public.sites (
  id,
  domain,
  name,
  project_name,
  website_url,
  is_beta,
  last_form_values,
  created_at,
  updated_at,
  last_audit_at
) VALUES
  (gen_random_uuid()::text, 'ahdath.info', NULL, 'أحداث.أنفو', 'https://www.ahdath.info/', FALSE, '{"homeUrl":"https://www.ahdath.info/","articleUrl":"https://www.ahdath.info/%D9%85%D9%82%D8%AF%D9%85-%D8%A7%D9%84%D8%A3%D8%AE%D8%A8%D8%A7%D8%B1-%D8%A8%D8%A7%D9%84%D9%82%D9%86%D8%A7%D8%A9-%D8%A7%D9%84%D8%A3%D9%88%D9%84%D9%89-%D8%A7%D9%84%D8%B2%D9%85%D9%8A%D9%84-%D8%B4%D9%87/"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  ('358e783f-e559-470a-a1cd-291c04576949', 'akhbaar24.com', NULL, NULL, NULL, FALSE, '{"homeUrl":"https://www.akhbaar24.com/","articleUrl":"https://www.akhbaar24.com/%D9%85%D8%AD%D9%84%D9%8A%D8%A7%D8%AA/%D8%A8%D8%A3%D9%83%D8%AB%D8%B1-%D9%85%D9%86-300-%D8%B3%D8%A7%D8%B9%D8%A9-%D8%B9%D9%85%D9%84-%D8%AD%D8%B1%D9%81%D9%8A%D9%88-%D9%88%D8%B7%D9%84%D8%A7%D8%A8-%D9%88%D8%B1%D8%AB-%D9%8A%D9%86%D8%AC%D8%B2%D9%88%D9%86-%D8%A3%D8%AF%D9%88%D8%A7%D8%AA-%D8%BA%D8%B3%D9%84-%D8%A7%D9%84%D9%83%D8%B9%D8%A8%D8%A9-762295"}'::jsonb, '2026-07-02T08:11:29.924Z'::timestamptz, '2026-07-02T08:11:29.924Z'::timestamptz, NULL),
  (gen_random_uuid()::text, 'al-madina.com', NULL, 'جريدة المدينة', 'https://www.al-madina.com/', FALSE, '{"homeUrl":"https://www.al-madina.com/","articleUrl":"https://www.al-madina.com/article/130509/%D9%85%D8%AC%D9%84%D8%B3-%D8%A7%D9%84%D9%88%D8%B2%D8%B1%D8%A7%D8%A1-400-%D8%A5%D9%84%D9%89-800-%D8%B1%D9%8A%D8%A7%D9%84-%D8%A8%D8%AF%D9%84-%D8%A7%D9%86%D8%AA%D8%AF%D8%A7%D8%A8-%D9%84%D9%84%D8%B6%D8%A8%D8%A7%D8%B7-%D9%88%D8%A7%D9%84%D8%A3%D9%81%D8%B1%D8%A7%D8%AF-%D9%8A%D8%A8%D8%AF%D8%A3-%D8%A8-150-%D8%B1%D9%8A%D8%A7%D9%84%D8%A7-%D8%B9%D9%86-%D9%83%D9%84-%D9%8A%D9%88%D9%85"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'aljarida.com', NULL, 'جريدة الجريدة الكويتية', 'https://www.aljarida.com/', FALSE, '{"homeUrl":"https://www.aljarida.com/","articleUrl":"https://www.aljarida.com/article/136311"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  ('a1eb8c55-2334-4dce-b7b5-2008d36824a5', 'alkhaleej.ae', NULL, NULL, NULL, FALSE, '{"homeUrl":"https://www.alkhaleej.ae/","articleUrl":"https://www.alkhaleej.ae/2026-04-08/%D8%A8%D8%B9%D8%AF-%D9%82%D8%B1%D8%A7%D8%B1-%D9%88%D9%82%D9%81-%D8%A5%D8%B7%D9%84%D8%A7%D9%82-%D8%A7%D9%84%D9%86%D8%A7%D8%B1-%D9%88%D8%A7%D8%B4%D9%86%D8%B7%D9%86-%D9%88%D8%B7%D9%87%D8%B1%D8%A7%D9%86-%D9%8A%D8%AA%D8%A8%D8%A7%D8%AF%D9%84%D8%A7%D9%86-%D8%A5%D8%B9%D9%84%D8%A7%D9%86-%D8%A7%D9%84%D9%86%D8%B5%D8%B1-6394091/%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85/%D8%B3%D9%8A%D8%A7%D8%B3%D8%A9"}'::jsonb, '2026-06-30T05:45:01.225Z'::timestamptz, '2026-06-30T05:45:01.225Z'::timestamptz, NULL),
  (gen_random_uuid()::text, 'almasryalyoum.com', NULL, 'المصري اليوم', 'https://www.almasryalyoum.com/', FALSE, '{"homeUrl":"https://www.almasryalyoum.com/","articleUrl":"https://www.almasryalyoum.com/news/details/4325791"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'alraimedia.com', NULL, 'Alrai-media', 'https://www.alraimedia.com/', FALSE, '{"homeUrl":"https://www.alraimedia.com/","articleUrl":"https://www.alraimedia.com/article/1774379/%D9%85%D8%AD%D9%84%D9%8A%D8%A7%D8%AA/%D8%A3%D8%AE%D8%A8%D8%A7%D8%B1-%D9%85%D8%AD%D9%84%D9%8A%D8%A9/%D8%B5%D8%AF%D9%88%D8%B1-6-%D9%85%D8%B1%D8%A7%D8%B3%D9%8A%D9%85-%D8%A8%D8%B3%D8%AD%D8%A8-%D9%88%D8%A5%D8%B3%D9%82%D8%A7%D8%B7-%D8%A7%D9%84%D8%AC%D9%86%D8%B3%D9%8A%D8%A9-%D8%B9%D9%86-25-%D8%B4%D8%AE%D8%B5%D8%A7"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'alseyassah.com', NULL, 'السياسة', 'https://alseyassah.com/', FALSE, '{"homeUrl":"https://alseyassah.com/","articleUrl":"https://alseyassah.com/article/467415/%D8%A7%D9%84%D8%B3%D9%8A%D8%A7%D8%B3%D8%A9-%D8%AA%D9%86%D8%B4%D8%B1-%D8%A3%D8%B3%D9%85%D8%A7%D8%A1-%D8%A7%D9%84%D8%B7%D9%84%D8%A8%D8%A9-%D8%A7%D9%84%D9%86%D8%A7%D8%AC%D8%AD%D9%8A%D9%86-%D9%81%D9%8A-%D8%A7%D9%84%D8%B5%D9%81-%D8%A7%D9%84%D8%AB%D8%A7%D9%86%D9%8A-%D8%B9%D8%B4%D8%B1-%D8%A8%D8%A7%D9%84%D9%82%D8%B3%D9%85-%D8%A7%D9%84%D8%B9%D9%84%D9%85%D9%8A/"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'alwatan.com.sa', NULL, 'watanksa', 'https://www.alwatan.com.sa/', FALSE, '{"homeUrl":"https://www.alwatan.com.sa/","articleUrl":"https://www.alwatan.com.sa/article/1182418"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'alwatan.om', NULL, 'الوطن', 'https://alwatan.om/', FALSE, '{"homeUrl":"https://alwatan.om/","articleUrl":"https://alwatan.om/details/228566"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  ('2caa6811-b51b-46ef-8b1a-e4546d515a90', 'arabtimesonline.com', NULL, NULL, NULL, FALSE, '{"homeUrl":"https://www.arabtimesonline.com/","articleUrl":"https://www.arabtimesonline.com/news/kuwaitis-and-expats-urged-to-activate-electronic-signature-for-government-and-banking-services/"}'::jsonb, '2026-08-04T05:23:50.843Z'::timestamptz, '2026-08-04T05:23:50.843Z'::timestamptz, NULL),
  ('a1d342aa-5699-4ac0-bdf2-e73e1a806d30', 'beta.al-madina.com', NULL, 'beta.al-madina', 'https://beta.al-madina.com/', FALSE, '{"tagUrl":"https://beta.al-madina.com/tag/%D8%BA%D8%B2%D8%A9","homeUrl":"https://beta.al-madina.com/","authorUrl":"https://beta.al-madina.com/author/2052/%D8%B3%D8%B9%D9%88%D8%AF-%D8%A7%D9%84%D8%A8%D9%84%D9%88%D9%8A","searchUrl":"https://beta.al-madina.com/search?query=%D8%B1%D9%8A%D8%A7%D9%84%20%D9%85%D8%AF%D8%B1%D9%8A%D8%AF","articleUrl":"https://beta.al-madina.com/article/999219/%D9%85%D8%AD%D9%84%D9%8A%D8%A7%D8%AA/%D9%85%D8%AD%D8%A7%D9%81%D8%B8-%D8%AC%D8%AF%D8%A9-%D9%8A%D8%AD%D8%B6%D8%B1-%D8%AD%D9%81%D9%84-%D9%82%D9%86%D8%B5%D9%84%D9%8A%D8%A9-%D8%A7%D9%84%D9%85%D9%85%D9%84%D9%83%D8%A9-%D8%A7%D9%84%D9%85%D8%BA%D8%B1%D8%A8%D9%8A%D8%A9-%D8%A8%D8%AC%D8%AF%D8%A9-%D8%A8%D9%85%D9%86%D8%A7%D8%B3%D8%A8%D8%A9-%D8%A7%D9%84%D9%8A%D9%88%D9%85-%D8%A7%D9%84%D9%88%D8%B7%D9%86%D9%8A","sectionUrl":"https://beta.al-madina.com/%D8%A7%D9%82%D8%AA%D8%B5%D8%A7%D8%AF","videoArticleUrl":"https://beta.al-madina.com/article/903753/%D9%85%D9%8A%D8%AF%D9%8A%D8%A7/%D9%85%D8%AD%D9%85%D9%8A%D8%A9-%D8%A7%D9%84%D9%85%D9%84%D9%83-%D8%B3%D9%84%D9%85%D8%A7%D9%86-%D8%AA%D8%AD%D8%AA%D8%B6%D9%86-350-%D9%86%D9%88%D8%B9%D8%A7-%D9%85%D9%86-%D8%A7%D9%84%D8%AD%D9%8A%D9%88%D8%A7%D9%86%D8%A7%D8%AA-%D8%A7%D9%84%D8%A8%D8%B1%D9%8A%D8%A9"}'::jsonb, '2026-08-03T07:48:56.446Z'::timestamptz, '2026-08-03T07:48:56.446Z'::timestamptz, NULL),
  ('56b7cdbc-76dd-492b-b600-4e3ca621e538', 'beta.makkahnewspaper.com', NULL, NULL, NULL, FALSE, '{"tagUrl":"https://beta.makkahnewspaper.com/tags/%D8%A7%D9%84%D8%B1%D9%87%D8%A7%D8%A8-%D8%A7%D9%84%D8%A5%D9%86%D8%B3%D8%A7%D9%86%D9%8A","homeUrl":"https://beta.makkahnewspaper.com/","authorUrl":"https://beta.makkahnewspaper.com/author/7293/%D8%A8%D8%B1%D8%AC%D8%B3-%D8%AD%D9%85%D9%88%D8%AF-%D8%A7%D9%84%D8%A8%D8%B1%D8%AC%D8%B3","searchUrl":"https://beta.makkahnewspaper.com/search?query=%D8%B1%D9%8A%D8%A7%D9%84+%D9%85%D8%AF%D8%B1%D9%8A%D8%AF","articleUrl":"https://beta.makkahnewspaper.com/article/1633415/%D9%85%D8%B9%D8%B1%D9%81%D8%A9/40-%D9%85%D8%B4%D8%A7%D8%B1%D9%83%D8%A7-%D9%8A%D8%AE%D8%AA%D8%AA%D9%85%D9%88%D9%86-%D8%AC%D8%B3%D9%88%D8%B1-%D8%A7%D9%84%D9%81%D9%86-2025-2026-%D8%A8%D8%AE%D8%A8%D8%B1%D8%A7%D8%AA-%D8%AF%D9%88%D9%84%D9%8A%D8%A9","sectionUrl":"https://beta.makkahnewspaper.com/%D8%A7%D9%84%D8%A8%D9%84%D8%AF","videoArticleUrl":"https://beta.makkahnewspaper.com/article/1576026/%D9%81%D9%8A%D8%AF%D9%8A%D9%88/%D9%85%D9%86-%D8%AD%D8%A8%D9%87%D8%A7-%D9%84%D8%AE%D8%AF%D9%85%D8%A9-%D8%A7%D9%84%D9%85%D8%AC%D8%AA%D9%85%D8%B9-%D8%AA%D9%85%D9%83%D9%86%D8%AA-%D8%B4%D8%B1%D9%83%D8%A9-%D9%85%D8%A7%D9%83%D8%AF%D9%88%D9%86%D8%A7%D9%84%D8%AF%D8%B2-%D8%A8%D9%86%D8%B4%D8%B1-%D8%A7%D9%84%D8%AE%D9%8A%D8%B1-%D9%88%D8%A7%D9%84%D8%AA%D8%A8%D8%B1%D8%B9-%D9%84-%D9%88%D9%82%D9%81-%D8%AF%D8%A7%D8%B1%D9%83%D9%85"}'::jsonb, '2026-07-22T06:48:19.744Z'::timestamptz, '2026-07-22T06:48:19.744Z'::timestamptz, NULL),
  (gen_random_uuid()::text, 'cincainews.com', NULL, '精彩大马', 'https://www.cincainews.com/', FALSE, '{"homeUrl":"https://www.cincainews.com/","articleUrl":"https://www.cincainews.com/news/money/2025/11/19/tambadana-secure-online-personal-loan-solution-for-malaysian-working-adults/198915"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  ('7836920c-7b7a-42b9-b13e-14d43a614be7', 'cnnbusinessarabic.com', NULL, NULL, NULL, FALSE, '{"homeUrl":"https://cnnbusinessarabic.com/","articleUrl":"https://cnnbusinessarabic.com/finance-markets/1144338/عاجل-النفط-يهزم-الذكاء-الاصطناعي-وول-ستريت-تنهي-الجلسة-في-المنطقة-الحمراء","xmlSitemapUrl":"https://cnnbusinessarabic.com/sitemaps/sitemap_0.xml","newsSitemapUrl":"https://cnnbusinessarabic.com/sitemaps/latest_articles.xml"}'::jsonb, '2026-07-14T06:50:49.618Z'::timestamptz, '2026-07-14T06:50:49.618Z'::timestamptz, NULL),
  (gen_random_uuid()::text, 'communityimpact.com', NULL, 'Community Impact Newspaper', 'https://communityimpact.com/', FALSE, '{"homeUrl":"https://communityimpact.com/","articleUrl":"https://communityimpact.com/frisco/election/final-mark-hill-wins-race-for-frisco-mayor/"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'emirates247.com', NULL, 'Emirates 24|7', 'https://www.emirates247.com/', FALSE, '{"homeUrl":"https://www.emirates247.com/","articleUrl":"https://www.emirates247.com/uae-guide/uaes-pledge-and-commitment-initiative-how-to-take-part-and-download-your-certificate/2286"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'fratmat.info', NULL, 'FratMat', 'https://www.fratmat.info/', FALSE, '{"homeUrl":"https://www.fratmat.info/","articleUrl":"https://www.fratmat.info/article/2642262/societe/cepe-2026-les-resultats-sont-disponibles"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'guardiansun.co.bw', NULL, 'Guardian Sun', 'https://guardiansun.co.bw/', FALSE, '{"homeUrl":"https://guardiansun.co.bw/","articleUrl":"https://guardiansun.co.bw/News/car-brake-fluid-used-to-spike-drinks-during-beer-binges"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  ('085c54c0-85a3-45da-b1b8-d88140004158', 'gulf-times.com', NULL, 'https://www.gulf-times.com/', 'https://www.gulf-times.com/', FALSE, '{"homeUrl":"https://www.gulf-times.com/","articleUrl":"https://www.gulf-times.com/article/729755/qatar/maldives-president-receives-credentials-of-qatars-ambassador"}'::jsonb, '2026-07-23T07:06:16.622Z'::timestamptz, '2026-07-23T07:06:16.622Z'::timestamptz, NULL),
  (gen_random_uuid()::text, 'jamalouki.net', NULL, 'جمالك', 'https://jamalouki.net/', FALSE, '{"homeUrl":"https://jamalouki.net/","articleUrl":"https://jamalouki.net/%D9%84%D8%A7%D9%8A%D9%81-%D8%B3%D8%AA%D8%A7%D9%8A%D9%84/%D8%A3%D8%A8%D8%B1%D8%A7%D8%AC/%D8%AA%D9%88%D9%82%D8%B9%D8%A7%D8%AA-%D8%A7%D9%84%D8%A3%D8%A8%D8%B1%D8%A7%D8%AC-%D9%84%D8%B4%D9%87%D8%B1-%D9%8A%D9%88%D9%84%D9%8A%D9%88-2026-%D9%85%D9%86-%D9%85%D8%A7%D8%BA%D9%8A-%D9%81%D8%B1%D8%AD"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'kuwaittimes.com', NULL, 'Kuwait Times', 'https://kuwaittimes.com/', FALSE, '{"homeUrl":"https://kuwaittimes.com/","articleUrl":"https://kuwaittimes.com/article/44790/kuwait/other-news/cabinet-decides-islamic-new-year-holiday-schedule/"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'live-uae.com', NULL, 'عيش الإمارات | Live UAE', 'https://www.live-uae.com/', FALSE, '{"homeUrl":"https://www.live-uae.com/","articleUrl":"https://www.live-uae.com/article/330/%D8%A3%D8%A8%D8%B1%D8%A7%D8%AC-%D8%A7%D9%84%D8%A7%D8%AA%D8%AD%D8%A7%D8%AF-%D8%A3%D9%8A%D9%82%D9%88%D9%86%D8%A9-%D8%A3%D8%A8%D9%88%D8%B8%D8%A8%D9%8A-%D8%A7%D9%84%D8%B2%D8%AC%D8%A7%D8%AC%D9%8A%D8%A9-%D9%85%D9%86-%D8%A7%D9%84%D8%AA%D8%B5%D9%85%D9%8A%D9%85-%D8%A5%D9%84%D9%89-%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85%D9%8A%D8%A9"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'lobservateur.info', NULL, 'LobservateurDuMaroc', 'https://lobservateur.info/', FALSE, '{"homeUrl":"https://lobservateur.info/","articleUrl":"https://lobservateur.info/article/112142/culture/musique/qui-est-lazaro-le-chanteur-de-mehboul-ana-au-110-millions-de-vues-"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  ('1571ae46-2954-4110-acbc-12a2e0cf9658', 'makkahnewspaper.com', NULL, 'makkahnewspaper.com', 'https://makkahnewspaper.com/', FALSE, '{"tagUrl":"https://makkahnewspaper.com/tags/%D9%88%D8%B2%D8%A7%D8%B1%D8%A9-%D8%A7%D9%84%D8%A8%D9%8A%D8%A6%D8%A9-%D9%88%D8%A7%D9%84%D9%85%D9%8A%D8%A7%D9%87-%D9%88%D8%A7%D9%84%D8%B2%D8%B1%D8%A7%D8%B9%D8%A9","homeUrl":"https://makkahnewspaper.com/","authorUrl":"https://makkahnewspaper.com/author/10238/%D9%85%D8%B5%D9%84%D8%AD-%D9%85%D8%B9%D9%8A%D8%B6-%D9%85%D8%B5%D9%84%D8%AD","searchUrl":"https://makkahnewspaper.com/search?query=%D8%B1%D9%8A%D8%A7%D9%84+%D9%85%D8%AF%D8%B1%D9%8A%D8%AF","articleUrl":"https://makkahnewspaper.com/article/1633414/%D8%A7%D9%84%D8%A8%D9%84%D8%AF/%D8%A7%D9%84%D8%A8%D9%8A%D8%A6%D8%A9-%D8%AA%D9%85%D8%AF%D8%AF-%D9%85%D9%87%D9%84%D8%A9-%D8%A7%D9%84%D8%AD%D8%B5%D9%88%D9%84-%D8%B9%D9%84%D9%89-%D8%B1%D8%AE%D8%B5-%D8%A7%D8%B3%D8%AA%D8%AE%D8%AF%D8%A7%D9%85-%D9%85%D9%8A%D8%A7%D9%87-%D8%A7%D9%84%D8%A2%D8%A8%D8%A7%D8%B1-%D9%84%D9%85%D8%AF%D8%A9-%D8%B9%D8%A7%D9%85","sectionUrl":"https://makkahnewspaper.com/%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85","robotsTxtUrl":"https://makkahnewspaper.com/robots.txt","xmlSitemapUrl":"https://makkahnewspaper.com/sitemaps/sitemap_0.xml","newsSitemapUrl":"https://makkahnewspaper.com/sitemaps/newsSitemap.xml","videoArticleUrl":"https://makkahnewspaper.com/article/1576026/%D9%81%D9%8A%D8%AF%D9%8A%D9%88/%D9%85%D9%86-%D8%AD%D8%A8%D9%87%D8%A7-%D9%84%D8%AE%D8%AF%D9%85%D8%A9-%D8%A7%D9%84%D9%85%D8%AC%D8%AA%D9%85%D8%B9-%D8%AA%D9%85%D9%83%D9%86%D8%AA-%D8%B4%D8%B1%D9%83%D8%A9-%D9%85%D8%A7%D9%83%D8%AF%D9%88%D9%86%D8%A7%D9%84%D8%AF%D8%B2-%D8%A8%D9%86%D8%B4%D8%B1-%D8%A7%D9%84%D8%AE%D9%8A%D8%B1-%D9%88%D8%A7%D9%84%D8%AA%D8%A8%D8%B1%D8%B9-%D9%84-%D9%88%D9%82%D9%81-%D8%AF%D8%A7%D8%B1%D9%83%D9%85"}'::jsonb, '2026-07-22T09:33:13.570Z'::timestamptz, '2026-07-22T09:33:13.570Z'::timestamptz, NULL),
  (gen_random_uuid()::text, 'malaymail.com', NULL, 'Malay Mail', 'https://www.malaymail.com/', FALSE, '{"homeUrl":"https://www.malaymail.com/","articleUrl":"https://www.malaymail.com/news/malaysia/2026/06/07/how-malaysians-can-watch-the-fifa-world-cup-2026-a-complete-guide/221841"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'manilatimes.net', NULL, 'The Manila Times', 'https://www.manilatimes.net/', FALSE, '{"homeUrl":"https://www.manilatimes.net/","articleUrl":"https://www.manilatimes.net/2026/05/31/regions/marcos-declares-17-local-holidays-in-june/2354978"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  ('01c57206-ebdf-44cd-8bba-c33b812c3521', 'new.al-madina.com', NULL, NULL, NULL, FALSE, '{"homeUrl":"https://new.al-madina.com/","articleUrl":"https://new.al-madina.com/category/local"}'::jsonb, '2026-06-23T13:55:00.056Z'::timestamptz, '2026-06-23T13:55:00.056Z'::timestamptz, NULL),
  (gen_random_uuid()::text, 'newtimes.co.rw', NULL, 'The New Times', 'https://www.newtimes.co.rw/', FALSE, '{"homeUrl":"https://www.newtimes.co.rw/","articleUrl":"https://www.newtimes.co.rw/article/32423/news/crime/yampano-sex-tape-case-court-rejects-suspects-bail-appeal"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  ('3628aac3-2a0e-4e8c-8e9c-583328f2a9d7', 'next.al-madina.com', NULL, NULL, NULL, FALSE, '{"homeUrl":"https://next.al-madina.com/","authorUrl":"https://next.al-madina.com/article/994629/%D9%83%D8%AA%D8%A7%D8%A8/%D8%A7%D9%84%D9%82%D9%88%D9%84-%D8%A7%D9%84%D9%85%D9%86%D8%AA%D8%AC%D8%A8-%D9%81%D9%8A-%D8%A3%D8%AD%D8%A8-%D9%85%D9%86%D8%AA%D8%AE%D8%A8","searchUrl":"https://next.al-madina.com/search?query=%D8%B1%D9%8A%D8%A7%D9%84%20%D9%85%D8%AF%D8%B1%D9%8A%D8%AF","articleUrl":"https://next.al-madina.com/article/994638/%D8%AF%D9%88%D9%84%D9%8A%D8%A9/%D8%B2%D9%84%D8%B2%D8%A7%D9%84-%D8%A8%D9%82%D9%88%D8%A9-71-%D8%AF%D8%B1%D8%AC%D8%A7%D8%AA-%D9%8A%D8%B6%D8%B1%D8%A8-%D8%B3%D9%88%D8%A7%D8%AD%D9%84-%D9%81%D9%86%D8%B2%D9%88%D9%8A%D9%84%D8%A7","sectionUrl":"https://next.al-madina.com/%D8%A7%D9%82%D8%AA%D8%B5%D8%A7%D8%AF","xmlSitemapUrl":"https://next.al-madina.com/sitemap.xml"}'::jsonb, '2026-06-23T13:43:51.751Z'::timestamptz, '2026-06-23T13:43:51.751Z'::timestamptz, NULL),
  ('7bd41c4a-1a8d-4dab-a650-860b044f5961', 'next.gulf-times.com', NULL, 'next.gulf-times', 'https://next.gulf-times.com/', FALSE, '{"tagUrl":"https://next.gulf-times.com/tag?query=creative","homeUrl":"https://next.gulf-times.com/","authorUrl":"https://next.gulf-times.com/author/45/faisal-almudahka","articleUrl":"https://next.gulf-times.com/article/729137/qatar/hh-the-amir-bids-farewell-to-father-amir","sectionUrl":"https://next.gulf-times.com/qatar"}'::jsonb, '2026-07-13T09:44:04.501Z'::timestamptz, '2026-07-13T09:44:04.501Z'::timestamptz, NULL),
  ('0002f52c-9907-4ed7-afd4-7362f24e2d62', 'next.makkahnewspaper.com', NULL, 'next.makkahnewspaper', 'https://next.makkahnewspaper.com/', FALSE, '{"tagUrl":"https://next.makkahnewspaper.com/tags/%D8%A7%D9%84%D8%B1%D9%87%D8%A7%D8%A8-%D8%A7%D9%84%D8%A5%D9%86%D8%B3%D8%A7%D9%86%D9%8A","homeUrl":"https://next.makkahnewspaper.com/","authorUrl":"https://next.makkahnewspaper.com/author/11142/%D8%AA%D8%B1%D9%83%D9%8A-%D8%A7%D9%84%D9%82%D8%A8%D9%84%D8%A7%D9%86","searchUrl":"https://next.makkahnewspaper.com/search?query=%D8%B1%D9%8A%D8%A7%D9%84%20%D9%85%D8%AF%D8%B1%D9%8A%D8%AF","articleUrl":"https://next.makkahnewspaper.com/article/1632696/%D8%A7%D9%84%D8%A3%D9%88%D9%84%D9%89/90-%D9%85%D9%84%D9%8A%D8%A7%D8%B1-%D8%B1%D9%8A%D8%A7%D9%84-%D9%81%D8%A7%D8%A6%D8%B6-%D8%A7%D9%84%D9%85%D9%8A%D8%B2%D8%A7%D9%86-%D8%A7%D9%84%D8%AA%D8%AC%D8%A7%D8%B1%D9%8A-%D9%84%D9%84%D9%85%D9%85%D9%84%D9%83%D8%A9-%D8%AE%D9%84%D8%A7%D9%84-%D8%A7%D9%84%D8%B1%D8%A8%D8%B9-%D8%A7%D9%84%D8%A3%D9%88%D9%84-%D9%84%D8%B9%D8%A7%D9%85-2026","sectionUrl":"https://next.makkahnewspaper.com/%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85","videoArticleUrl":"https://next.makkahnewspaper.com/article/1576333/%D9%81%D9%8A%D8%AF%D9%8A%D9%88/%D8%AC%D8%A7%D9%85%D8%B9%D8%A9-%D9%86%D8%A7%D9%8A%D9%81-%D8%AA%D9%86%D8%B8%D9%85-%D8%A7%D9%84%D8%AD%D9%81%D9%84-%D8%A7%D9%84%D8%B3%D9%86%D9%88%D9%8A-%D9%84%D8%AE%D8%B1%D9%8A%D8%AC%D9%8A-%D8%AF%D9%81%D8%B9%D8%A9-40-%D9%85%D9%86-%D8%B7%D9%84%D8%A7%D8%A8%D9%87%D8%A7"}'::jsonb, '2026-06-29T10:11:29.415Z'::timestamptz, '2026-06-29T10:11:29.415Z'::timestamptz, NULL),
  ('ad215ac3-08be-4279-b828-30d0ee64eb3a', 'okaz.com.sa', NULL, 'okaz', 'https://www.okaz.com.sa', FALSE, '{"homeUrl":"https://www.okaz.com.sa","articleUrl":"https://www.okaz.com.sa/local/na/2242021"}'::jsonb, '2026-06-18T10:06:11.339Z'::timestamptz, '2026-06-18T10:06:11.339Z'::timestamptz, NULL),
  (gen_random_uuid()::text, 'omandaily.om', NULL, 'جريدة عمان', 'https://www.omandaily.om/', FALSE, '{"homeUrl":"https://www.omandaily.om/","articleUrl":"https://www.omandaily.om/%D8%B4%D8%B1%D9%81%D8%A7%D8%AA/%D9%82%D8%B5%D8%B5-%D8%B3%D8%B1%D9%8A%D8%B1-%D8%B9%D9%84%D9%89-%D8%B5%D9%81%D9%8A%D8%AD-%D8%B3%D8%A7%D8%AE%D9%86"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'omanobserver.om', NULL, 'Oman Observer', 'https://www.omanobserver.om/', FALSE, '{"homeUrl":"https://www.omanobserver.om/","articleUrl":"https://www.omanobserver.om/article/1191223/oman/cbo-sets-deadline-for-banknote-replacement"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'pouvoirsafrique.com', NULL, 'Pouvoirs d''Afrique', 'https://pouvoirsafrique.com/', FALSE, '{"homeUrl":"https://pouvoirsafrique.com/","articleUrl":"https://pouvoirsafrique.com/article/2094/bfootball-le-classement-des-meilleurs-championnats-africainb"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'powersofafrica.com', NULL, 'Powers of Africa', 'https://powersofafrica.com/', FALSE, '{"homeUrl":"https://powersofafrica.com/","articleUrl":"https://powersofafrica.com/article/3935/fifa-rankings-morocco-achieves-its-best-ever-position"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'qatar-tribune.com', NULL, 'Qatar Tribune', 'https://www.qatar-tribune.com/', FALSE, '{"homeUrl":"https://www.qatar-tribune.com/","articleUrl":"https://www.qatar-tribune.com/article/245942/latest-news/qcaa-shuts-two-travel-and-air-cargo-agencies-deregisters-10-others-for-violations"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'saudigazette.com.sa', NULL, 'Saudi Gazette', 'https://saudigazette.com.sa/', FALSE, '{"homeUrl":"https://saudigazette.com.sa/","articleUrl":"https://saudigazette.com.sa/article/662464/saudi-arabia/absher-carries-out-over-43-million-electronic-transactions-last-month"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'sinardaily.my', NULL, 'Sinar Daily', 'https://www.sinardaily.my/', FALSE, '{"homeUrl":"https://www.sinardaily.my/","articleUrl":"https://www.sinardaily.my/article/736979/focus/national/rohingya-activist-under-fire-after-viral-speech-targets-malaysia"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'sinarharian.com.my', NULL, 'Sinar Harian', 'https://www.sinarharian.com.my/', FALSE, '{"homeUrl":"https://www.sinarharian.com.my/","articleUrl":"https://www.sinarharian.com.my/article/785505/berita/politik/senarai-penuh-172-calon-prn-johor-2026"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'sinarplus.sinarharian.com.my', NULL, 'SinarPlus', 'https://sinarplus.sinarharian.com.my/', FALSE, '{"homeUrl":"https://sinarplus.sinarharian.com.my/","articleUrl":"https://sinarplus.sinarharian.com.my/article/185857/lifestyle/kisah-masyarakat/arwah-baik-sangat-jaga-solat-pelajar-upm-maut-tersedut-tangki-air-ketika-intern-berikut-kronologi-kejadian"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'sunstar.com.ph', NULL, 'SunStar Publishing Inc.', 'https://www.sunstar.com.ph/', FALSE, '{"homeUrl":"https://www.sunstar.com.ph/","articleUrl":"https://www.sunstar.com.ph/manila/summary-ferdinand-marcos-jrs-sona-2026"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'thehimalayantimes.com', NULL, 'The Himalayan Times', 'https://thehimalayantimes.com/', FALSE, '{"homeUrl":"https://thehimalayantimes.com/","articleUrl":"https://thehimalayantimes.com/business/nepals-shinta-mani-mustang-crowned-worlds-best-luxury-hotel"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL),
  (gen_random_uuid()::text, 'tv9english.com', NULL, 'TV9 English', 'https://www.tv9english.com/', FALSE, '{"homeUrl":"https://www.tv9english.com/","articleUrl":"https://www.tv9english.com/lifestyle/martyrs-day-2026-what-happened-on-30-january-1948-article-10887398.html"}'::jsonb, clock_timestamp(), clock_timestamp(), NULL);

DO $verification$
DECLARE
  table_count integer;
  project_count integer;
  configured_count integer;
  migration_count integer;
BEGIN
  SELECT count(*) INTO table_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
    AND table_name IN (
      'schema_migrations', 'seo_analyses', 'sites', 'seed_urls',
      'audit_runs', 'audit_results'
    );

  SELECT count(*),
         count(*) FILTER (
           WHERE last_form_values ? 'homeUrl'
             AND last_form_values ? 'articleUrl'
         )
    INTO project_count, configured_count
  FROM public.sites;

  SELECT count(*) INTO migration_count FROM public.schema_migrations;

  IF table_count <> 6 THEN
    RAISE EXCEPTION 'expected 6 application tables, got %', table_count;
  END IF;
  IF project_count <> 45 THEN
    RAISE EXCEPTION 'expected 45 projects, got %', project_count;
  END IF;
  IF configured_count <> 45 THEN
    RAISE EXCEPTION 'expected 45 configured projects, got %', configured_count;
  END IF;
  IF migration_count <> 9 THEN
    RAISE EXCEPTION 'expected 9 recorded migrations, got %', migration_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_runs)
     OR EXISTS (SELECT 1 FROM public.audit_results)
     OR EXISTS (SELECT 1 FROM public.seed_urls)
     OR EXISTS (SELECT 1 FROM public.seo_analyses) THEN
    RAISE EXCEPTION 'historical tables must start empty in this non-historical bootstrap';
  END IF;
END
$verification$;

SELECT
  current_database() AS database_name,
  current_user AS database_user,
  (SELECT count(*) FROM public.sites) AS total_projects,
  (SELECT count(*) FROM public.sites
   WHERE last_form_values ? 'homeUrl'
     AND last_form_values ? 'articleUrl') AS configured_projects,
  (SELECT count(*) FROM public.audit_runs) AS audit_runs;

\if :apply
COMMIT;
\echo 'SUCCESS: full schema and 45 configured projects committed to the empty database.'
\else
ROLLBACK;
\echo 'SUCCESS: full bootstrap dry run passed and rolled back; database was not changed.'
\endif
