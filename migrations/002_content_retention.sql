-- Assemble selects by publication window, so index that column directly.
-- content_items_kind_published_idx is (kind, published_at) and cannot serve a
-- kind-agnostic range scan.
CREATE INDEX IF NOT EXISTS content_items_published_idx
  ON content_items (published_at DESC);

-- Retention prune joins against issue_items to protect referenced rows.
CREATE INDEX IF NOT EXISTS issue_items_content_idx
  ON issue_items (content_item_id);
