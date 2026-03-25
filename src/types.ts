export interface SEOAnalysis {
  url: string;
  status: string;
  meta: {
    title: string | null;
    description: string | null;
    h1: string | null;
    word_count: number;
    language: string | null;
  };
  technical_seo: {
    robots_txt_content: string | null;
    robots_txt_valid: boolean;
    sitemap_xml_valid: boolean;
    sitemap_xml_location: string | null;
    canonical_url: string | null;
    canonical_conflict: boolean;
    redirect_chain: string[];
    noindex: boolean;
    nofollow: boolean;
    hreflang_tags: string[];
    structured_data: any[];
    structured_data_valid: boolean;
    duplicate_title: boolean;
    duplicate_description: boolean;
    missing_title: boolean;
    missing_description: boolean;
    broken_internal_links: number;
    broken_external_links: number;
    missing_alt_tags: number;
  };
  content_analysis: {
    headings: {
      h1: string[];
      h2: string[];
      h3: string[];
      h4: string[];
      h5: string[];
      h6: string[];
    };
    primary_topics: string[];
    entities: string[];
    keyword_density_percentage: Record<string, number>;
    content_depth_score: number;
    content_uniqueness_score: number;
    top_anchors: Array<{text: string; count: number}>;
  };
  performance: {
    estimated_lcp: string;
    estimated_cls_risk: string;
    estimated_inp_risk: string;
    mobile_friendly: boolean;
    viewport_meta: boolean;
    font_size_appropriate: boolean;
    tap_targets_appropriate: boolean;
  };
  site_structure: {
    internal_urls: string[];
    internal_link_count: number;
    external_link_count: number;
    orphan_risk_score: number;
    average_link_depth: number;
  };
  recommendations: string[];
}
