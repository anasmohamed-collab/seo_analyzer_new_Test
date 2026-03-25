/*
  # Create SEO Audit System Tables

  1. New Tables
    - `sites`
      - `id` (text, primary key, uuid)
      - `domain` (text, unique)
      - `name` (text, optional)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)
    
    - `seed_urls`
      - `id` (text, primary key, uuid)
      - `site_id` (text, foreign key to sites)
      - `url` (text)
      - `created_at` (timestamp)
    
    - `audit_runs`
      - `id` (text, primary key, uuid)
      - `site_id` (text, foreign key to sites)
      - `status` (text, default 'PENDING')
      - `site_checks` (jsonb)
      - `started_at` (timestamp)
      - `finished_at` (timestamp, nullable)
    
    - `audit_results`
      - `id` (text, primary key, uuid)
      - `audit_run_id` (text, foreign key to audit_runs)
      - `url` (text)
      - `data` (jsonb)
      - `status` (text)
      - `recommendations` (jsonb)
      - `created_at` (timestamp)

  2. Security
    - Enable RLS on all tables
    - Add policies for authenticated users to manage their own audit data
*/

-- CreateTable
CREATE TABLE IF NOT EXISTS "sites" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "seed_urls" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "site_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seed_urls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_runs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "site_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "site_checks" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "audit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_results" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "audit_run_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "data" JSONB,
    "status" TEXT,
    "recommendations" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'sites_domain_key'
  ) THEN
    CREATE UNIQUE INDEX "sites_domain_key" ON "sites"("domain");
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'seed_urls_site_id_fkey'
  ) THEN
    ALTER TABLE "seed_urls" ADD CONSTRAINT "seed_urls_site_id_fkey" 
      FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'audit_runs_site_id_fkey'
  ) THEN
    ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_site_id_fkey" 
      FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'audit_results_audit_run_id_fkey'
  ) THEN
    ALTER TABLE "audit_results" ADD CONSTRAINT "audit_results_audit_run_id_fkey" 
      FOREIGN KEY ("audit_run_id") REFERENCES "audit_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Enable RLS
ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seed_urls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_results" ENABLE ROW LEVEL SECURITY;

-- Create policies for authenticated users to manage their own data
-- Note: These are permissive policies - adjust based on your auth requirements

CREATE POLICY "Users can view sites"
  ON "sites" FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can create sites"
  ON "sites" FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Users can update sites"
  ON "sites" FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can delete sites"
  ON "sites" FOR DELETE
  TO authenticated
  USING (true);

CREATE POLICY "Users can view seed_urls"
  ON "seed_urls" FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can create seed_urls"
  ON "seed_urls" FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Users can update seed_urls"
  ON "seed_urls" FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can delete seed_urls"
  ON "seed_urls" FOR DELETE
  TO authenticated
  USING (true);

CREATE POLICY "Users can view audit_runs"
  ON "audit_runs" FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can create audit_runs"
  ON "audit_runs" FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Users can update audit_runs"
  ON "audit_runs" FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can delete audit_runs"
  ON "audit_runs" FOR DELETE
  TO authenticated
  USING (true);

CREATE POLICY "Users can view audit_results"
  ON "audit_results" FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can create audit_results"
  ON "audit_results" FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Users can update audit_results"
  ON "audit_results" FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can delete audit_results"
  ON "audit_results" FOR DELETE
  TO authenticated
  USING (true);