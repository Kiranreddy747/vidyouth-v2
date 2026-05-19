-- 009_notifications.sql  (vidyouth-admin-backend owns notif templates)
--
-- PRD §10.3 Notification Template Configuration. One row per notification
-- type with independently-toggleable Email / SMS / Push channels and
-- {{variable}} substitution. Preview renders with sample data.

CREATE TABLE IF NOT EXISTS notification_templates (
  key            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email_subject  TEXT,
  email_html     TEXT,
  email_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  sms_body       TEXT,
  sms_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  push_title     TEXT,
  push_body      TEXT,
  push_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO notification_templates (key, name, email_subject, email_html, sms_body) VALUES
  ('welcome',        'Welcome',
   'Welcome to Vidyouth, {{user_name}}',
   '<p>Hi {{user_name}}, welcome to Vidyouth!</p>',
   'Welcome to Vidyouth, {{user_name}}!'),
  ('cert_issued',    'Certificate Issued',
   'Your {{topic_name}} certificate is ready',
   '<p>Congratulations {{user_name}}! Download: {{cert_download_url}}</p>',
   'Your {{topic_name}} certificate ({{cert_id}}) is ready.'),
  ('payment_receipt','Payment Receipt',
   'Payment received: {{amount}}',
   '<p>We received {{amount}} from {{user_name}}.</p>',
   'Vidyouth: payment of {{amount}} received.')
ON CONFLICT (key) DO NOTHING;
