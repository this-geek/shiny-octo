/**
 * Day-1 company profile view (Phase 1J §7) — read-only view of the buyer's
 * Shopify Company, tier, locations (with tax-exempt flag) and team contacts.
 *
 * Migrated to the 2026.4 Preact + web-component surface — same data + UX
 * as the React original.
 */

import { useEffect, useState } from 'preact/hooks';
import { useApi } from '@shopify/ui-extensions/customer-account/preact';
import { fetchCompanyProfile, type CompanyProfileResponse } from './api';

function formatDiscount(t: NonNullable<CompanyProfileResponse['tier']>): string {
  if (t.discount_type === 'percent') return `${t.discount_value}% off`;
  return `${t.discount_value.toFixed(2)} off per unit`;
}

interface Props {
  workerBaseUrl: string;
}

export default function CompanyProfileView({ workerBaseUrl }: Props) {
  const api = useApi<'customer-account.page.render'>();
  const [profile, setProfile] = useState<CompanyProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workerBaseUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await api.sessionToken.get();
        const data = await fetchCompanyProfile(workerBaseUrl, token);
        if (!cancelled) setProfile(data);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, workerBaseUrl]);

  if (error) return <s-banner tone="critical">{error}</s-banner>;
  if (!profile) return <s-spinner accessibilityLabel="Loading profile" />;

  if (!profile.buyer.is_b2b) {
    return <s-text>This account is not linked to a wholesale company yet.</s-text>;
  }

  return (
    <s-stack direction="block" gap="loose">
      {profile.company ? (
        <s-stack direction="block" gap="tight">
          <s-heading>Company</s-heading>
          <s-text>{profile.company.name}</s-text>
        </s-stack>
      ) : (
        <s-text>No company linked.</s-text>
      )}

      {profile.tier ? (
        <s-stack direction="block" gap="tight">
          <s-heading>Pricing tier</s-heading>
          <s-text>{profile.tier.name}</s-text>
          <s-text>{formatDiscount(profile.tier)}</s-text>
        </s-stack>
      ) : (
        <s-stack direction="block" gap="tight">
          <s-heading>Pricing tier</s-heading>
          <s-text>No tier assigned yet — your account manager will set this.</s-text>
        </s-stack>
      )}

      {profile.company && profile.company.locations.length > 0 && (
        <s-stack direction="block" gap="tight">
          <s-heading>Locations</s-heading>
          {profile.company.locations.map(loc => (
            <s-stack key={loc.id} direction="block" gap="none">
              <s-text>{loc.name}</s-text>
              <s-text>{loc.tax_exempt ? 'Tax-exempt' : 'Tax applies at checkout'}</s-text>
            </s-stack>
          ))}
        </s-stack>
      )}

      {profile.company && profile.company.contacts.length > 0 && (
        <s-stack direction="block" gap="tight">
          <s-heading>Team</s-heading>
          {profile.company.contacts.map(c => (
            <s-stack key={c.customer_id} direction="block" gap="none">
              <s-text>
                {c.name}
                {c.is_main ? ' · primary' : ''}
              </s-text>
              <s-text>{c.email}</s-text>
            </s-stack>
          ))}
        </s-stack>
      )}
    </s-stack>
  );
}
