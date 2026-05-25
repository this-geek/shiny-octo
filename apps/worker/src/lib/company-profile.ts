/**
 * Day-1 company profile data assembly (Phase 1J §7).
 *
 * Pulls together the read-only "your wholesale account" view shown in the
 * customer-account UI extension. Source of truth is Shopify for the Company
 * shape (name, contacts, locations, tax-exempt flag); the tier name +
 * discount come from our D1 mapping.
 */

import type { Env } from '../types.js';
import type { BuyerCtx } from './buyer-context.js';
import { decrypt } from './crypto.js';

export interface CompanyContact {
  customer_id: string;
  name: string;
  email: string;
  is_main: boolean;
}

export interface CompanyLocation {
  id: string;
  name: string;
  tax_exempt: boolean;
}

export interface TierSummary {
  id: number;
  name: string;
  discount_type: 'percent' | 'fixed_amount';
  discount_value: number;
}

export interface CompanyProfile {
  company: {
    id: string;
    name: string;
    contacts: CompanyContact[];
    locations: CompanyLocation[];
  } | null;
  tier: TierSummary | null;
  buyer: {
    customer_id: string;
    is_b2b: boolean;
  };
}

interface CompanyQueryResp {
  data?: {
    company?: {
      id: string;
      name: string;
      contactsCount?: { count: number };
      contacts?: {
        edges: Array<{
          node: {
            customer: { id: string; firstName: string | null; lastName: string | null; email: string };
            isMainContact: boolean;
          };
        }>;
      };
      locations?: {
        edges: Array<{ node: { id: string; name: string; taxExempt: boolean } }>;
      };
    };
  };
  errors?: Array<{ message: string }>;
}

async function loadCompanyFromShopify(
  shopDomain: string,
  token: string,
  apiVersion: string,
  companyGid: string,
): Promise<CompanyProfile['company']> {
  const query = `query CompanyProfile($id: ID!) {
    company(id: $id) {
      id
      name
      contacts(first: 20) {
        edges {
          node {
            isMainContact
            customer { id firstName lastName email }
          }
        }
      }
      locations(first: 20) {
        edges { node { id name taxExempt } }
      }
    }
  }`;
  const res = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables: { id: companyGid } }),
    },
  );
  if (!res.ok) throw new Error(`company profile HTTP ${res.status}`);
  const json = (await res.json()) as CompanyQueryResp;
  if (json.errors?.length) {
    throw new Error(`company profile errors: ${json.errors.map(e => e.message).join(', ')}`);
  }
  const co = json.data?.company;
  if (!co) return null;
  return {
    id: co.id,
    name: co.name,
    contacts: (co.contacts?.edges ?? []).map(e => ({
      customer_id: e.node.customer.id,
      name: [e.node.customer.firstName, e.node.customer.lastName].filter(Boolean).join(' ').trim()
        || e.node.customer.email,
      email: e.node.customer.email,
      is_main: e.node.isMainContact,
    })),
    locations: (co.locations?.edges ?? []).map(e => ({
      id: e.node.id,
      name: e.node.name,
      tax_exempt: e.node.taxExempt,
    })),
  };
}

async function loadTier(db: D1Database, tierId: number): Promise<TierSummary | null> {
  const row = await db
    .prepare(
      `SELECT id, name, discount_type, discount_value
       FROM tiers WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(tierId)
    .first<{ id: number; name: string; discount_type: string; discount_value: number }>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    discount_type: row.discount_type as TierSummary['discount_type'],
    discount_value: row.discount_value,
  };
}

export async function buildCompanyProfile(
  env: Env,
  buyer: BuyerCtx,
): Promise<CompanyProfile> {
  const profile: CompanyProfile = {
    company: null,
    tier: null,
    buyer: { customer_id: buyer.customer_id, is_b2b: buyer.is_b2b },
  };

  if (buyer.tier_id != null) {
    profile.tier = await loadTier(env.DB, buyer.tier_id);
  }

  if (buyer.shopify_company_id) {
    const shopRow = await env.DB.prepare(
      `SELECT access_token_encrypted FROM shops
       WHERE id = ? AND uninstalled_at IS NULL`,
    )
      .bind(buyer.shop_id)
      .first<{ access_token_encrypted: string }>();
    if (shopRow) {
      const token = await decrypt(shopRow.access_token_encrypted, buyer.shop_domain, env.MASTER_KEY);
      profile.company = await loadCompanyFromShopify(
        buyer.shop_domain,
        token,
        env.SHOPIFY_API_VERSION,
        buyer.shopify_company_id,
      );
    }
  }

  return profile;
}
