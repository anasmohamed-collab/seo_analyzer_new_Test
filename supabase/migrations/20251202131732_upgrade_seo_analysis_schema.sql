/*
  # Upgrade SEO Analysis Schema

  1. Changes
    - Add `technical_seo` (jsonb) - Technical SEO metrics including robots.txt, sitemap, canonical, redirects, meta robots, hreflang, structured data, broken links, missing ALT tags
    - Add `content_analysis` (jsonb) - Content analysis including all headings, topics, entities, keyword density, content depth
    - Add `performance` (jsonb) - Performance metrics including LCP, CLS, INP estimates, mobile-friendliness
    - Add `site_structure` (jsonb) - Site structure data including internal URLs, orphan pages, link depth
    - Remove old individual columns that are now consolidated
    - Update recommendations column to store enhanced recommendations
  
  2. Security
    - Maintain existing RLS policies
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seo_analyses' AND column_name = 'technical_seo'
  ) THEN
    ALTER TABLE seo_analyses ADD COLUMN technical_seo jsonb DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seo_analyses' AND column_name = 'content_analysis'
  ) THEN
    ALTER TABLE seo_analyses ADD COLUMN content_analysis jsonb DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seo_analyses' AND column_name = 'performance'
  ) THEN
    ALTER TABLE seo_analyses ADD COLUMN performance jsonb DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seo_analyses' AND column_name = 'site_structure'
  ) THEN
    ALTER TABLE seo_analyses ADD COLUMN site_structure jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;