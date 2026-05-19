variable "name_prefix" { type = string }
variable "cost_mode" { type = string }

variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_app_subnet_ids" { type = list(string) }

variable "alb_security_group_id" { type = string }
variable "ec2_security_group_id" { type = string }

variable "ec2_instance_profile_name" { type = string }
variable "data_kms_arn" { type = string }

variable "image_tag" {
  description = "Initial value for the SSM parameter holding the deployed ECR image tag."
  type        = string
  default     = "v0.0.0-placeholder"
}

variable "tags" {
  type    = map(string)
  default = {}
}

# ─── Data tier wiring (from module.data) ─────────────────────────────────────
variable "aws_region" { type = string }

variable "rds_address" { type = string }
variable "rds_port" { type = number }
variable "rds_db_name" { type = string }

# RDS master username is set in modules/data/rds.tf. Kept as a variable so the
# two places can't silently drift.
variable "rds_master_username" {
  type    = string
  default = "vidyouthadmin"
}

variable "redis_primary_endpoint" { type = string }
variable "redis_port" { type = number }

# ─── Secrets Manager ARNs (from module.secrets) ──────────────────────────────
variable "db_master_secret_arn" { type = string }
variable "redis_auth_secret_arn" { type = string }
variable "jwt_private_key_secret_arn" { type = string }
variable "jwt_public_key_secret_arn" { type = string }
variable "bcrypt_pepper_secret_arn" { type = string }

# ─── Application runtime config (overridable via tfvars) ─────────────────────
variable "email_provider" {
  description = "mock | ses. SES sender must be a verified identity."
  type        = string
  default     = "ses"
}

variable "sms_provider" {
  description = "mock | sns | msg91. Default mock until DLT entity/template are set."
  type        = string
  default     = "mock"
}

variable "email_from" {
  type    = string
  default = "vidyouth2@gmail.com"
}

variable "ses_from_email" {
  type    = string
  default = "vidyouth2@gmail.com"
}

variable "app_base_url" {
  description = "Public base URL the app builds verification/reset links from. Set to the ALB or domain URL."
  type        = string
  default     = ""
}

variable "oauth_success_redirect_url" {
  description = "Where the OAuth callback sends the browser after a successful login."
  type        = string
  default     = ""
}
