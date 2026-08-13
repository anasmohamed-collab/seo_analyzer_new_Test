\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif
\encoding UTF8

-- Manual, fail-closed Production import for the validated 2026-08-13 GSC set.
-- This file is NOT a migration and must never be added to an automatic migration path.
-- Default mode is a real transactional dry-run followed by ROLLBACK.
-- COMMIT requires: psql ... -v apply=true -f PRODUCTION_PROJECT_IMPORT.sql
--
-- Safety contract:
--   * INSERT only; no UPDATE or DELETE statements.
--   * Requires the exact 13-domain preflight inventory.
--   * Requires all 32 incoming domains to be absent.
--   * Locks sites and audit_runs against concurrent writes for the transaction.
--   * Aborts unless all 32 rows insert and all 13 pre-existing rows stay byte-equivalent.
--   * Stores only the reviewed homeUrl + articleUrl pair, matching the application contract.

\if :apply
\echo 'APPLY MODE: the transaction will COMMIT only if every guard succeeds.'
\else
\echo 'DRY-RUN MODE: every statement will execute, then the transaction will ROLLBACK.'
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

SELECT pg_advisory_xact_lock(hashtextextended('seo-analyzer:gsc-project-import:2026-08-13', 0));
LOCK TABLE public.sites, public.audit_runs IN SHARE ROW EXCLUSIVE MODE;

DO $schema_guard$
DECLARE
  missing_columns text;
BEGIN
  SELECT string_agg(required.column_name, ', ' ORDER BY required.column_name)
    INTO missing_columns
  FROM (VALUES
    ('id'), ('domain'), ('project_name'), ('website_url'), ('is_beta'),
    ('last_form_values'), ('created_at'), ('updated_at')
  ) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'sites'
      AND c.column_name = required.column_name
  );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'sites schema is missing required column(s): %', missing_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sites'
      AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) = 'UNIQUE (domain)'
  ) THEN
    RAISE EXCEPTION 'sites.domain UNIQUE constraint is missing';
  END IF;
END
$schema_guard$;

CREATE TEMP TABLE expected_existing_domains (
  domain text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO expected_existing_domains (domain) VALUES
  ('akhbaar24.com'),
  ('alkhaleej.ae'),
  ('arabtimesonline.com'),
  ('beta.al-madina.com'),
  ('beta.makkahnewspaper.com'),
  ('cnnbusinessarabic.com'),
  ('gulf-times.com'),
  ('makkahnewspaper.com'),
  ('new.al-madina.com'),
  ('next.al-madina.com'),
  ('next.gulf-times.com'),
  ('next.makkahnewspaper.com'),
  ('okaz.com.sa');

CREATE TEMP TABLE incoming_projects (
  domain text PRIMARY KEY,
  project_name text NOT NULL,
  website_url text NOT NULL,
  home_url text NOT NULL,
  article_url text NOT NULL
) ON COMMIT DROP;

INSERT INTO incoming_projects (domain, project_name, website_url, home_url, article_url) VALUES
  ('ahdath.info', 'أحداث.أنفو', 'https://www.ahdath.info/', 'https://www.ahdath.info/', 'https://www.ahdath.info/%D9%85%D9%82%D8%AF%D9%85-%D8%A7%D9%84%D8%A3%D8%AE%D8%A8%D8%A7%D8%B1-%D8%A8%D8%A7%D9%84%D9%82%D9%86%D8%A7%D8%A9-%D8%A7%D9%84%D8%A3%D9%88%D9%84%D9%89-%D8%A7%D9%84%D8%B2%D9%85%D9%8A%D9%84-%D8%B4%D9%87/'),
  ('al-madina.com', 'جريدة المدينة', 'https://www.al-madina.com/', 'https://www.al-madina.com/', 'https://www.al-madina.com/article/130509/%D9%85%D8%AC%D9%84%D8%B3-%D8%A7%D9%84%D9%88%D8%B2%D8%B1%D8%A7%D8%A1-400-%D8%A5%D9%84%D9%89-800-%D8%B1%D9%8A%D8%A7%D9%84-%D8%A8%D8%AF%D9%84-%D8%A7%D9%86%D8%AA%D8%AF%D8%A7%D8%A8-%D9%84%D9%84%D8%B6%D8%A8%D8%A7%D8%B7-%D9%88%D8%A7%D9%84%D8%A3%D9%81%D8%B1%D8%A7%D8%AF-%D9%8A%D8%A8%D8%AF%D8%A3-%D8%A8-150-%D8%B1%D9%8A%D8%A7%D9%84%D8%A7-%D8%B9%D9%86-%D9%83%D9%84-%D9%8A%D9%88%D9%85'),
  ('aljarida.com', 'جريدة الجريدة الكويتية', 'https://www.aljarida.com/', 'https://www.aljarida.com/', 'https://www.aljarida.com/article/136311'),
  ('almasryalyoum.com', 'المصري اليوم', 'https://www.almasryalyoum.com/', 'https://www.almasryalyoum.com/', 'https://www.almasryalyoum.com/news/details/4325791'),
  ('alraimedia.com', 'Alrai-media', 'https://www.alraimedia.com/', 'https://www.alraimedia.com/', 'https://www.alraimedia.com/article/1774379/%D9%85%D8%AD%D9%84%D9%8A%D8%A7%D8%AA/%D8%A3%D8%AE%D8%A8%D8%A7%D8%B1-%D9%85%D8%AD%D9%84%D9%8A%D8%A9/%D8%B5%D8%AF%D9%88%D8%B1-6-%D9%85%D8%B1%D8%A7%D8%B3%D9%8A%D9%85-%D8%A8%D8%B3%D8%AD%D8%A8-%D9%88%D8%A5%D8%B3%D9%82%D8%A7%D8%B7-%D8%A7%D9%84%D8%AC%D9%86%D8%B3%D9%8A%D8%A9-%D8%B9%D9%86-25-%D8%B4%D8%AE%D8%B5%D8%A7'),
  ('alseyassah.com', 'السياسة', 'https://alseyassah.com/', 'https://alseyassah.com/', 'https://alseyassah.com/article/467415/%D8%A7%D9%84%D8%B3%D9%8A%D8%A7%D8%B3%D8%A9-%D8%AA%D9%86%D8%B4%D8%B1-%D8%A3%D8%B3%D9%85%D8%A7%D8%A1-%D8%A7%D9%84%D8%B7%D9%84%D8%A8%D8%A9-%D8%A7%D9%84%D9%86%D8%A7%D8%AC%D8%AD%D9%8A%D9%86-%D9%81%D9%8A-%D8%A7%D9%84%D8%B5%D9%81-%D8%A7%D9%84%D8%AB%D8%A7%D9%86%D9%8A-%D8%B9%D8%B4%D8%B1-%D8%A8%D8%A7%D9%84%D9%82%D8%B3%D9%85-%D8%A7%D9%84%D8%B9%D9%84%D9%85%D9%8A/'),
  ('alwatan.com.sa', 'watanksa', 'https://www.alwatan.com.sa/', 'https://www.alwatan.com.sa/', 'https://www.alwatan.com.sa/article/1182418'),
  ('alwatan.om', 'الوطن', 'https://alwatan.om/', 'https://alwatan.om/', 'https://alwatan.om/details/228566'),
  ('cincainews.com', '精彩大马', 'https://www.cincainews.com/', 'https://www.cincainews.com/', 'https://www.cincainews.com/news/money/2025/11/19/tambadana-secure-online-personal-loan-solution-for-malaysian-working-adults/198915'),
  ('communityimpact.com', 'Community Impact Newspaper', 'https://communityimpact.com/', 'https://communityimpact.com/', 'https://communityimpact.com/frisco/election/final-mark-hill-wins-race-for-frisco-mayor/'),
  ('emirates247.com', 'Emirates 24|7', 'https://www.emirates247.com/', 'https://www.emirates247.com/', 'https://www.emirates247.com/uae-guide/uaes-pledge-and-commitment-initiative-how-to-take-part-and-download-your-certificate/2286'),
  ('fratmat.info', 'FratMat', 'https://www.fratmat.info/', 'https://www.fratmat.info/', 'https://www.fratmat.info/article/2642262/societe/cepe-2026-les-resultats-sont-disponibles'),
  ('guardiansun.co.bw', 'Guardian Sun', 'https://guardiansun.co.bw/', 'https://guardiansun.co.bw/', 'https://guardiansun.co.bw/News/car-brake-fluid-used-to-spike-drinks-during-beer-binges'),
  ('jamalouki.net', 'جمالك', 'https://jamalouki.net/', 'https://jamalouki.net/', 'https://jamalouki.net/%D9%84%D8%A7%D9%8A%D9%81-%D8%B3%D8%AA%D8%A7%D9%8A%D9%84/%D8%A3%D8%A8%D8%B1%D8%A7%D8%AC/%D8%AA%D9%88%D9%82%D8%B9%D8%A7%D8%AA-%D8%A7%D9%84%D8%A3%D8%A8%D8%B1%D8%A7%D8%AC-%D9%84%D8%B4%D9%87%D8%B1-%D9%8A%D9%88%D9%84%D9%8A%D9%88-2026-%D9%85%D9%86-%D9%85%D8%A7%D8%BA%D9%8A-%D9%81%D8%B1%D8%AD'),
  ('kuwaittimes.com', 'Kuwait Times', 'https://kuwaittimes.com/', 'https://kuwaittimes.com/', 'https://kuwaittimes.com/article/44790/kuwait/other-news/cabinet-decides-islamic-new-year-holiday-schedule/'),
  ('live-uae.com', 'عيش الإمارات | Live UAE', 'https://www.live-uae.com/', 'https://www.live-uae.com/', 'https://www.live-uae.com/article/330/%D8%A3%D8%A8%D8%B1%D8%A7%D8%AC-%D8%A7%D9%84%D8%A7%D8%AA%D8%AD%D8%A7%D8%AF-%D8%A3%D9%8A%D9%82%D9%88%D9%86%D8%A9-%D8%A3%D8%A8%D9%88%D8%B8%D8%A8%D9%8A-%D8%A7%D9%84%D8%B2%D8%AC%D8%A7%D8%AC%D9%8A%D8%A9-%D9%85%D9%86-%D8%A7%D9%84%D8%AA%D8%B5%D9%85%D9%8A%D9%85-%D8%A5%D9%84%D9%89-%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85%D9%8A%D8%A9'),
  ('lobservateur.info', 'LobservateurDuMaroc', 'https://lobservateur.info/', 'https://lobservateur.info/', 'https://lobservateur.info/article/112142/culture/musique/qui-est-lazaro-le-chanteur-de-mehboul-ana-au-110-millions-de-vues-'),
  ('malaymail.com', 'Malay Mail', 'https://www.malaymail.com/', 'https://www.malaymail.com/', 'https://www.malaymail.com/news/malaysia/2026/06/07/how-malaysians-can-watch-the-fifa-world-cup-2026-a-complete-guide/221841'),
  ('manilatimes.net', 'The Manila Times', 'https://www.manilatimes.net/', 'https://www.manilatimes.net/', 'https://www.manilatimes.net/2026/05/31/regions/marcos-declares-17-local-holidays-in-june/2354978'),
  ('newtimes.co.rw', 'The New Times', 'https://www.newtimes.co.rw/', 'https://www.newtimes.co.rw/', 'https://www.newtimes.co.rw/article/32423/news/crime/yampano-sex-tape-case-court-rejects-suspects-bail-appeal'),
  ('omandaily.om', 'جريدة عمان', 'https://www.omandaily.om/', 'https://www.omandaily.om/', 'https://www.omandaily.om/%D8%B4%D8%B1%D9%81%D8%A7%D8%AA/%D9%82%D8%B5%D8%B5-%D8%B3%D8%B1%D9%8A%D8%B1-%D8%B9%D9%84%D9%89-%D8%B5%D9%81%D9%8A%D8%AD-%D8%B3%D8%A7%D8%AE%D9%86'),
  ('omanobserver.om', 'Oman Observer', 'https://www.omanobserver.om/', 'https://www.omanobserver.om/', 'https://www.omanobserver.om/article/1191223/oman/cbo-sets-deadline-for-banknote-replacement'),
  ('pouvoirsafrique.com', 'Pouvoirs d''Afrique', 'https://pouvoirsafrique.com/', 'https://pouvoirsafrique.com/', 'https://pouvoirsafrique.com/article/2094/bfootball-le-classement-des-meilleurs-championnats-africainb'),
  ('powersofafrica.com', 'Powers of Africa', 'https://powersofafrica.com/', 'https://powersofafrica.com/', 'https://powersofafrica.com/article/3935/fifa-rankings-morocco-achieves-its-best-ever-position'),
  ('qatar-tribune.com', 'Qatar Tribune', 'https://www.qatar-tribune.com/', 'https://www.qatar-tribune.com/', 'https://www.qatar-tribune.com/article/245942/latest-news/qcaa-shuts-two-travel-and-air-cargo-agencies-deregisters-10-others-for-violations'),
  ('saudigazette.com.sa', 'Saudi Gazette', 'https://saudigazette.com.sa/', 'https://saudigazette.com.sa/', 'https://saudigazette.com.sa/article/662464/saudi-arabia/absher-carries-out-over-43-million-electronic-transactions-last-month'),
  ('sinardaily.my', 'Sinar Daily', 'https://www.sinardaily.my/', 'https://www.sinardaily.my/', 'https://www.sinardaily.my/article/736979/focus/national/rohingya-activist-under-fire-after-viral-speech-targets-malaysia'),
  ('sinarharian.com.my', 'Sinar Harian', 'https://www.sinarharian.com.my/', 'https://www.sinarharian.com.my/', 'https://www.sinarharian.com.my/article/785505/berita/politik/senarai-penuh-172-calon-prn-johor-2026'),
  ('sinarplus.sinarharian.com.my', 'SinarPlus', 'https://sinarplus.sinarharian.com.my/', 'https://sinarplus.sinarharian.com.my/', 'https://sinarplus.sinarharian.com.my/article/185857/lifestyle/kisah-masyarakat/arwah-baik-sangat-jaga-solat-pelajar-upm-maut-tersedut-tangki-air-ketika-intern-berikut-kronologi-kejadian'),
  ('sunstar.com.ph', 'SunStar Publishing Inc.', 'https://www.sunstar.com.ph/', 'https://www.sunstar.com.ph/', 'https://www.sunstar.com.ph/manila/summary-ferdinand-marcos-jrs-sona-2026'),
  ('thehimalayantimes.com', 'The Himalayan Times', 'https://thehimalayantimes.com/', 'https://thehimalayantimes.com/', 'https://thehimalayantimes.com/business/nepals-shinta-mani-mustang-crowned-worlds-best-luxury-hotel'),
  ('tv9english.com', 'TV9 English', 'https://www.tv9english.com/', 'https://www.tv9english.com/', 'https://www.tv9english.com/lifestyle/martyrs-day-2026-what-happened-on-30-january-1948-article-10887398.html');

DO $preflight_guard$
BEGIN
  IF (SELECT count(*) FROM expected_existing_domains) <> 13 THEN
    RAISE EXCEPTION 'embedded existing-domain guard must contain exactly 13 rows';
  END IF;

  IF (SELECT count(*) FROM incoming_projects) <> 32 THEN
    RAISE EXCEPTION 'embedded import must contain exactly 32 rows';
  END IF;

  IF EXISTS (
    SELECT domain FROM expected_existing_domains
    EXCEPT
    SELECT domain FROM public.sites
  ) OR EXISTS (
    SELECT domain FROM public.sites
    EXCEPT
    SELECT domain FROM expected_existing_domains
  ) THEN
    RAISE EXCEPTION 'Production domain inventory differs from the reviewed 13-domain snapshot';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM incoming_projects i
    JOIN public.sites s USING (domain)
  ) THEN
    RAISE EXCEPTION 'at least one incoming domain already exists; regenerate the import from a fresh inventory';
  END IF;

  IF EXISTS (SELECT 1 FROM public.audit_runs WHERE status = 'RUNNING') THEN
    RAISE EXCEPTION 'at least one audit is RUNNING; keep the runner paused and retry later';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM incoming_projects
    WHERE website_url !~ '^https://'
       OR home_url !~ '^https://'
       OR article_url !~ '^https://'
       OR regexp_replace(lower(substring(website_url FROM '^https://([^/?#]+)')), '^www\.', '') <> domain
       OR regexp_replace(lower(substring(home_url FROM '^https://([^/?#]+)')), '^www\.', '') <> domain
       OR regexp_replace(lower(substring(article_url FROM '^https://([^/?#]+)')), '^www\.', '') <> domain
  ) THEN
    RAISE EXCEPTION 'incoming URL validation failed';
  END IF;
END
$preflight_guard$;

CREATE TEMP TABLE sites_before ON COMMIT DROP AS
SELECT * FROM public.sites;

CREATE TEMP TABLE inserted_projects (
  id text PRIMARY KEY,
  domain text UNIQUE NOT NULL
) ON COMMIT DROP;

WITH inserted AS (
  INSERT INTO public.sites (
    domain,
    project_name,
    website_url,
    is_beta,
    last_form_values,
    updated_at
  )
  SELECT
    domain,
    project_name,
    website_url,
    FALSE,
    jsonb_build_object('homeUrl', home_url, 'articleUrl', article_url),
    clock_timestamp()
  FROM incoming_projects
  ORDER BY domain
  ON CONFLICT (domain) DO NOTHING
  RETURNING id, domain
)
INSERT INTO inserted_projects (id, domain)
SELECT id, domain FROM inserted;

DO $postflight_guard$
BEGIN
  IF (SELECT count(*) FROM inserted_projects) <> 32 THEN
    RAISE EXCEPTION 'expected 32 inserts, got %', (SELECT count(*) FROM inserted_projects);
  END IF;

  IF (SELECT count(*) FROM public.sites) <> 45 THEN
    RAISE EXCEPTION 'expected 45 total sites after staged insert, got %', (SELECT count(*) FROM public.sites);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM sites_before b
    LEFT JOIN public.sites s ON s.id = b.id
    WHERE s.id IS NULL OR to_jsonb(s) IS DISTINCT FROM to_jsonb(b)
  ) THEN
    RAISE EXCEPTION 'a pre-existing site changed during the import transaction';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM inserted_projects i
    JOIN public.audit_runs ar ON ar.site_id = i.id
  ) THEN
    RAISE EXCEPTION 'an audit run was created for an imported project';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM inserted_projects i
    JOIN public.sites s ON s.id = i.id
    JOIN incoming_projects p ON p.domain = i.domain
    WHERE s.project_name IS DISTINCT FROM p.project_name
       OR s.website_url IS DISTINCT FROM p.website_url
       OR s.is_beta IS DISTINCT FROM FALSE
       OR s.last_form_values IS DISTINCT FROM
          jsonb_build_object('homeUrl', p.home_url, 'articleUrl', p.article_url)
  ) THEN
    RAISE EXCEPTION 'an inserted site does not exactly match the reviewed payload';
  END IF;
END
$postflight_guard$;

SELECT
  s.id,
  s.domain,
  s.project_name,
  s.website_url,
  s.is_beta,
  s.last_form_values
FROM inserted_projects i
JOIN public.sites s ON s.id = i.id
ORDER BY s.domain;

\if :apply
COMMIT;
\echo 'SUCCESS: committed exactly 32 new projects; existing projects were unchanged.'
\else
ROLLBACK;
\echo 'SUCCESS: dry run passed and rolled back; Production was not changed.'
\endif
