/**
 * Four IAM roles plus their policies / instance profiles.
 *
 *   ec2-role           → assumed by EC2 instances. SSM access, CloudWatch
 *                        Agent, ECR pull, scoped Secrets Manager + KMS.
 *   rds-monitoring     → enhanced monitoring on RDS (assumed by RDS service)
 *   flow-logs          → VPC Flow Logs writing to CloudWatch
 *   events             → EventBridge → SNS / Step Functions later
 */

# ─── EC2 application role ────────────────────────────────────────────────────
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2" {
  name               = "${var.name_prefix}-ec2-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = var.tags
}

# AWS-managed policies we want as-is
resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "ec2_cwagent" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy_attachment" "ec2_ecr_read" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# Inline: tightly-scoped Secrets Manager read + KMS decrypt for our two keys.
data "aws_iam_policy_document" "ec2_inline" {
  statement {
    sid = "ReadAppSecrets"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      "arn:aws:secretsmanager:${data.aws_region.current.name}:${var.account_id}:secret:${var.name_prefix}/*",
    ]
  }

  statement {
    sid     = "DecryptDataAndSecrets"
    actions = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [
      aws_kms_key.data.arn,
      aws_kms_key.secrets.arn,
    ]
  }

  # Allow writing to the application's own log group (created in observability)
  statement {
    sid = "AppLogWrites"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${data.aws_region.current.name}:${var.account_id}:log-group:/${var.name_prefix}/*:*",
    ]
  }

  # Append-only access to the audit S3 bucket (object key prefix scoped per-instance)
  statement {
    sid = "AuditAppend"
    actions = [
      "s3:PutObject",
      "s3:PutObjectAcl",
    ]
    resources = [
      "arn:aws:s3:::${var.name_prefix}-audit-archive/audit/*",
    ]
  }

  # Read the SSM image-tag parameter (deployment pointer)
  statement {
    sid     = "ReadImageTag"
    actions = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [
      "arn:aws:ssm:${data.aws_region.current.name}:${var.account_id}:parameter/${var.name_prefix}/*",
    ]
  }

  # Transactional email (SES) + OTP SMS (SNS). This is what lets the app run
  # on the instance role instead of static AWS keys. SES SendEmail and SNS
  # SMS Publish are not resource-scopable the way ARNs are, so they are
  # constrained by action; the from-identity is enforced by SES verification.
  statement {
    sid = "SendEmailAndSms"
    actions = [
      "ses:SendEmail",
      "ses:SendRawEmail",
      "sns:Publish",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ec2_inline" {
  name   = "${var.name_prefix}-ec2-inline"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.ec2_inline.json
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${var.name_prefix}-ec2-profile"
  role = aws_iam_role.ec2.name
  tags = var.tags
}

# ─── RDS enhanced-monitoring role ────────────────────────────────────────────
data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "${var.name_prefix}-rds-monitoring-role"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ─── VPC Flow Logs role ──────────────────────────────────────────────────────
data "aws_iam_policy_document" "flow_logs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  name               = "${var.name_prefix}-flow-logs-role"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "flow_logs_inline" {
  statement {
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "flow_logs" {
  name   = "${var.name_prefix}-flow-logs-inline"
  role   = aws_iam_role.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs_inline.json
}

# ─── EventBridge role (for future cron / step-fn integrations) ───────────────
data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "events" {
  name               = "${var.name_prefix}-events-role"
  assume_role_policy = data.aws_iam_policy_document.events_assume.json
  tags               = var.tags
}
