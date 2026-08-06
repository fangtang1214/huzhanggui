UPDATE talent_window_products
SET promotion_link = NULL
WHERE promotion_link IS NOT NULL AND promotion_link NOT LIKE 'weixinstore%';
