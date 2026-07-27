/**
 * A brand's custom domain (dedicated domain or platform subdomain).
 *
 * Dedicated domains are validated through Cloudflare for SaaS: the platform
 * creates a custom hostname (async) and the owner proves control by adding a
 * TXT record plus a CNAME pointing at the platform domain. The CLI adds the
 * domain, surfaces those DNS records, and triggers validation.
 */
export interface BrandDomain {
    id: number;
    domain: string;
    /** true for a customer-owned dedicated domain; false for a platform subdomain. */
    dedicated_domain?: boolean | number;
    subdomain?: string | null;
    subdomain_root?: string | null;
    merchant_id?: number | null;
    merchant_code?: string | null;
    /**
     * Lifecycle: pending-cloudflare → pending-validation → validated
     * (or validation-failed / giveup-validation).
     */
    status?: string;
    /** Ownership-verification TXT record. Populated async by Cloudflare hostname creation. */
    txt_validation_record?: { name?: string; value?: string } | null;
    txt_validated?: boolean | number;
    cname_validation_record?: string | null;
    cname_validated?: boolean | number;
    cloudflare_hostname_id?: string | null;
    cloudflare_status?: string | null;
    ssl_status?: string | null;
    ssl_ready?: boolean;
    cloudflare_verification_errors?: string | null;
    created_at?: string;
    updated_at?: string;
}

/** A single DNS record the owner must add to validate/route the domain. */
export interface DomainDnsRecord {
    type: 'TXT' | 'CNAME' | string;
    /** Record host/name (may end with a trailing dot to signal a FQDN). */
    name: string;
    value: string;
    description?: string;
}

/** Response of GET .../domains/{id}/validation-instructions. */
export interface DomainValidationInstructions {
    domain: string;
    is_apex: boolean;
    records: DomainDnsRecord[];
    platform_domain: string;
    status?: string;
    cloudflare_status?: string | null;
    ssl_status?: string | null;
    cloudflare_verification_errors?: string | null;
    error?: string;
    message?: string;
}
