/**
 * Downloadable template for the generic orders format: one row per package. Orders with several
 * packages repeat the order columns; order lines (sku, units) may be listed on their own rows with
 * the package columns empty. The example row is clearly fictional.
 */
export const ORDERS_TEMPLATE_CSV = [
  "order_id,shipment_id,order_date,origin_zip,destination_zip,residential,service,package_seq,weight,weight_unit,length,width,height,sku,units,packaging",
  "EXAMPLE-1001,SHIP-1001,2026-01-15,90001,85001,yes,UPS Ground,1,3.5,lb,10,8,6,EXAMPLE-SKU,2,box",
  "# residential: yes/no (or true/false, 1/0, residential/commercial); weight_unit: lb or oz (g and kg are converted); dates: YYYY-MM-DD; service: the name your 3PL lists for it. Delete this line and the example row before uploading. Shopify and ShipHero exports can be uploaded as they are.",
  "",
].join("\n");
