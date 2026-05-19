/**
 * Remote state — S3 backend with DynamoDB lock.
 *
 * The bucket and lock table are bootstrapped MANUALLY via aws CLI before
 * `terraform init` runs the first time, because the state can't store itself.
 * See: ./bootstrap-backend.ps1 in this directory.
 *
 * The {{ACCOUNT_ID}} placeholder is filled in by the bootstrap script.
 * If you bootstrap manually, replace it with your AWS account ID.
 */

terraform {
  backend "s3" {
    bucket = "vidyouth-terraform-state-940932546129"
    key    = "prod/auth-service/terraform.tfstate"
    region = "ap-south-1"
    # The S3 backend resolves credentials independently of the aws provider,
    # so it needs its own profile (provider profile/var.aws_profile is not
    # consulted here). Matches aws_profile in terraform.tfvars.
    profile        = "vidyouth"
    dynamodb_table = "vidyouth-terraform-locks"
    encrypt        = true
  }
}
