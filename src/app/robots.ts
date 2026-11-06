import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/constants/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/dashboard",
        "/dashboard/",
        "/document-analysis",
        "/document-analysis/",
        "/analyses",
        "/analyses/",
        "/verify-email",
        "/forgot-password",
        "/reset-password",
        "/auth/",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
