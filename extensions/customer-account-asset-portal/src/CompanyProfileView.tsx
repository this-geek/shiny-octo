import { useEffect, useState } from 'react';
import {
  BlockStack,
  Banner,
  Heading,
  Spinner,
  Text,
  useApi,
} from '@shopify/ui-extensions-react/customer-account';
import { fetchCompanyProfile, type CompanyProfileResponse } from './api';

function formatDiscount(t: NonNullable<CompanyProfileResponse['tier']>): string {
  if (t.discount_type === 'percent') return `${t.discount_value}% off`;
  return `${t.discount_value.toFixed(2)} off per unit`;
}

interface Props {
  workerBaseUrl: string;
}

export default function CompanyProfileView({ workerBaseUrl }: Props): JSX.Element {
  const api = useApi();
  const [profile, setProfile] = useState<CompanyProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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

  if (error) return <Banner status="critical">{error}</Banner>;
  if (!profile) return <Spinner />;

  if (!profile.buyer.is_b2b) {
    return <Text>This account is not linked to a wholesale company yet.</Text>;
  }

  return (
    <BlockStack spacing="loose">
      {profile.company ? (
        <BlockStack spacing="tight">
          <Heading level={3}>Company</Heading>
          <Text>{profile.company.name}</Text>
        </BlockStack>
      ) : (
        <Text appearance="subdued">No company linked.</Text>
      )}

      {profile.tier ? (
        <BlockStack spacing="tight">
          <Heading level={3}>Pricing tier</Heading>
          <Text>{profile.tier.name}</Text>
          <Text appearance="subdued">{formatDiscount(profile.tier)}</Text>
        </BlockStack>
      ) : (
        <BlockStack spacing="tight">
          <Heading level={3}>Pricing tier</Heading>
          <Text appearance="subdued">No tier assigned yet — your account manager will set this.</Text>
        </BlockStack>
      )}

      {profile.company && profile.company.locations.length > 0 && (
        <BlockStack spacing="tight">
          <Heading level={3}>Locations</Heading>
          {profile.company.locations.map(loc => (
            <BlockStack key={loc.id} spacing="none">
              <Text>{loc.name}</Text>
              <Text appearance="subdued">
                {loc.tax_exempt ? 'Tax-exempt' : 'Tax applies at checkout'}
              </Text>
            </BlockStack>
          ))}
        </BlockStack>
      )}

      {profile.company && profile.company.contacts.length > 0 && (
        <BlockStack spacing="tight">
          <Heading level={3}>Team</Heading>
          {profile.company.contacts.map(c => (
            <BlockStack key={c.customer_id} spacing="none">
              <Text>
                {c.name}
                {c.is_main ? ' · primary' : ''}
              </Text>
              <Text appearance="subdued">{c.email}</Text>
            </BlockStack>
          ))}
        </BlockStack>
      )}
    </BlockStack>
  );
}
