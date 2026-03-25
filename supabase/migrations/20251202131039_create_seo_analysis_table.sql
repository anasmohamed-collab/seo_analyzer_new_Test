/*
  # SEO Analysis Storage Schema

  1. New Tables
    - `seo_analyses`
      - `id` (uuid, primary key) - Unique identifier for each analysis
      - `url` (text, not null) - The analyzed URL
      - `status` (text, not null) - Analysis status (success, error, etc.)
      - `meta_title` (text) - Page title
      - `meta_description` (text) - Meta description
      - `meta_h1` (text) - First H1 heading
      - `word_count` (integer, default 0) - Total word count
      - `internal_links` (integer, default 0) - Internal link count
      - `external_links` (integer, default 0) - External link count
      - `language` (text) - Detected language
      - `recommendations` (jsonb) - SEO recommendations array
      - `created_at` (timestamptz) - Analysis timestamp
  
  2. Security
    - Enable RLS on `seo_analyses` table
    - Add policy for public read access (SEO data is typically public)
    - Add policy for authenticated insert access
*/

CREATE TABLE IF NOT EXISTS seo_analyses (
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
  created_at timestamptz DEFAULT now()
);

ALTER TABLE seo_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read SEO analyses"
  ON seo_analyses
  FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can insert analyses"
  ON seo_analyses
  FOR INSERT
  TO authenticated
  WITH CHECK (true);