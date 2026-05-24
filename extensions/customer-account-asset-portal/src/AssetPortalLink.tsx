import {
  reactExtension,
  Link,
  Text,
  BlockStack,
} from '@shopify/ui-extensions-react/customer-account';

/**
 * Surfaces a link to the dealer asset portal on the order index page so
 * buyers can find it without hunting through the nav menu.
 */
function AssetPortalLink() {
  return (
    <BlockStack>
      <Text emphasis="bold">Dealer resources</Text>
      <Link to="extension:b2b-asset-portal/">Browse dealer assets</Link>
    </BlockStack>
  );
}

export default reactExtension('customer-account.order-index.block.render', () => (
  <AssetPortalLink />
));
