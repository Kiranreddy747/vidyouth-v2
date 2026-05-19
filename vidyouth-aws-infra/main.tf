/**
 * Root composition. Modules wire one direction:
 *   foundations -> networking -> secrets -> data -> application
 *                                                -> observability
 *                                                -> edge (conditional)
 */

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id    = data.aws_caller_identity.current.account_id
  partition     = data.aws_partition.current.partition
  region        = data.aws_region.current.name
  is_production = var.cost_mode == "production"

  common_tags = {
    Project     = "Vidyouth"
    Environment = var.environment
    ManagedBy   = "Terraform"
    CostMode    = var.cost_mode
  }
}

# ─── Phase 2 — Foundations (KMS keys + IAM roles) ────────────────────────────
module "foundations" {
  source = "./modules/foundations"

  name_prefix = var.name_prefix
  account_id  = local.account_id
  tags        = local.common_tags
}

# ─── Phase 3 — Networking ────────────────────────────────────────────────────
module "networking" {
  source = "./modules/networking"

  name_prefix        = var.name_prefix
  vpc_cidr           = var.vpc_cidr
  cost_mode          = var.cost_mode
  flow_logs_role_arn = module.foundations.flow_logs_role_arn
  tags               = local.common_tags
}

# ─── Phase 3.5 — Secrets Manager ─────────────────────────────────────────────
module "secrets" {
  source = "./modules/secrets"

  name_prefix     = var.name_prefix
  secrets_kms_arn = module.foundations.secrets_kms_arn
  tags            = local.common_tags
}

# ─── Phase 4 — Data tier (RDS + ElastiCache) ─────────────────────────────────
module "data" {
  source = "./modules/data"

  name_prefix             = var.name_prefix
  cost_mode               = var.cost_mode
  data_subnet_ids         = module.networking.private_data_subnet_ids
  rds_security_group_id   = module.networking.rds_security_group_id
  redis_security_group_id = module.networking.redis_security_group_id
  data_kms_arn            = module.foundations.data_kms_arn
  db_password_secret_arn  = module.secrets.db_master_password_arn
  redis_auth_secret_arn   = module.secrets.redis_auth_token_arn
  monitoring_role_arn     = module.foundations.rds_monitoring_role_arn
  tags                    = local.common_tags
}

# ─── Phase 5 — Application tier (ECR + LT + ASG + ALB) ───────────────────────
module "application" {
  source = "./modules/application"

  name_prefix               = var.name_prefix
  cost_mode                 = var.cost_mode
  vpc_id                    = module.networking.vpc_id
  public_subnet_ids         = module.networking.public_subnet_ids
  private_app_subnet_ids    = module.networking.private_app_subnet_ids
  alb_security_group_id     = module.networking.alb_security_group_id
  ec2_security_group_id     = module.networking.ec2_security_group_id
  ec2_instance_profile_name = module.foundations.ec2_instance_profile_name
  data_kms_arn              = module.foundations.data_kms_arn
  image_tag                 = var.auth_service_image_tag

  # Data tier + secrets so the launch template can build a real runtime config
  aws_region             = local.region
  rds_address            = module.data.rds_address
  rds_port               = module.data.rds_port
  rds_db_name            = module.data.rds_db_name
  redis_primary_endpoint = module.data.redis_primary_endpoint
  redis_port             = module.data.redis_port

  db_master_secret_arn       = module.secrets.db_master_password_arn
  redis_auth_secret_arn      = module.secrets.redis_auth_token_arn
  jwt_private_key_secret_arn = module.secrets.jwt_private_key_arn
  jwt_public_key_secret_arn  = module.secrets.jwt_public_key_arn
  bcrypt_pepper_secret_arn   = module.secrets.bcrypt_pepper_arn

  tags = local.common_tags
}

# ─── Phase 8 — Observability ─────────────────────────────────────────────────
module "observability" {
  source = "./modules/observability"

  name_prefix                = var.name_prefix
  cost_mode                  = var.cost_mode
  data_kms_arn               = module.foundations.data_kms_arn
  audit_kms_arn              = module.foundations.audit_kms_arn
  alerts_email               = var.alerts_email
  alb_arn_suffix             = module.application.alb_arn_suffix
  target_group_arn_suffix    = module.application.target_group_arn_suffix
  rds_instance_id            = module.data.rds_instance_id
  redis_replication_group_id = module.data.redis_replication_group_id
  asg_name                   = module.application.asg_name
  tags                       = local.common_tags
}

# ─── Phase 6 — Edge (Route53 + ACM + CloudFront + WAF). Conditional. ─────────
module "edge" {
  count  = var.domain_name != "" ? 1 : 0
  source = "./modules/edge"

  providers = {
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix  = var.name_prefix
  domain_name  = var.domain_name
  alb_dns_name = module.application.alb_dns_name
  tags         = local.common_tags
}
