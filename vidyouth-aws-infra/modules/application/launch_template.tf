/**
 * EC2 launch template + ASG.
 *
 *   production -> c6i.large, ASG min/desired/max = 2/2/6, IMDSv2 only,
 *                 30 GB encrypted gp3 root, target-tracking on AvgCPU 50%
 *   learning   -> t3.medium (same vCPU/RAM, burstable), ASG 1/1/2
 *
 * User-data script:
 *   - installs Docker + amazon-cloudwatch-agent
 *   - logs into ECR via the instance role
 *   - reads the image tag from SSM /{prefix}/auth-image-tag
 *   - docker pull + docker run -p 8080:8080 -d --restart=always
 *   - configures CloudWatch agent to ship /var/log/docker to a log group
 *
 * Health is /healthz on port 8080. The ALB target group polls it every 10s.
 */

locals {
  is_production     = var.cost_mode == "production"
  ec2_instance_type = local.is_production ? "c6i.large" : "t3.medium"
  asg_min           = local.is_production ? 2 : 1
  asg_desired       = local.is_production ? 2 : 1
  asg_max           = local.is_production ? 6 : 2

  # Until a domain + the edge module exist, the app is reachable over the ALB
  # DNS name on port 80. Fall back to that for self-referential URLs so
  # verification/reset links and the OAuth return URL resolve on first deploy.
  effective_app_base_url   = var.app_base_url != "" ? var.app_base_url : "http://${aws_lb.app.dns_name}"
  effective_oauth_redirect = var.oauth_success_redirect_url != "" ? var.oauth_success_redirect_url : "http://${aws_lb.app.dns_name}/newhome.html"
}

# Latest Amazon Linux 2023 AMI for x86_64
data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  user_data = base64encode(<<-EOT
    #!/bin/bash
    set -euo pipefail

    REGION="${data.aws_region.current.name}"
    ACCOUNT_ID="${data.aws_caller_identity.current.account_id}"
    ECR_REPO="${aws_ecr_repository.auth.repository_url}"
    SSM_TAG_PARAM="/${var.name_prefix}/auth-image-tag"
    LOG_GROUP="/${var.name_prefix}/auth-service"

    # 1. base packages
    dnf update -y
    dnf install -y docker jq amazon-cloudwatch-agent

    # 2. docker
    systemctl enable --now docker
    usermod -aG docker ec2-user

    # 3. ECR login (uses the IAM instance role)
    aws ecr get-login-password --region "$REGION" \
      | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

    # 4. resolve current tag from SSM
    IMAGE_TAG=$(aws ssm get-parameter --name "$SSM_TAG_PARAM" --region "$REGION" --query Parameter.Value --output text)
    IMAGE="$ECR_REPO:$IMAGE_TAG"

    # 4.5 build the runtime config from Secrets Manager + the data tier.
    #     Pulled with the instance role (no static AWS keys anywhere).
    get_secret() {
      aws secretsmanager get-secret-value --secret-id "$1" \
        --region "$REGION" --query SecretString --output text
    }
    DB_PW=$(get_secret "${var.db_master_secret_arn}")
    REDIS_TOKEN=$(get_secret "${var.redis_auth_secret_arn}")
    JWT_PRIVATE_KEY=$(get_secret "${var.jwt_private_key_secret_arn}")
    JWT_PUBLIC_KEY=$(get_secret "${var.jwt_public_key_secret_arn}")
    BCRYPT_PEPPER=$(get_secret "${var.bcrypt_pepper_secret_arn}")

    # URL-encode credentials so connection strings stay valid even with
    # special characters in the generated passwords.
    DB_PW_ENC=$(jq -rn --arg v "$DB_PW" '$v|@uri')
    REDIS_TOKEN_ENC=$(jq -rn --arg v "$REDIS_TOKEN" '$v|@uri')

    DATABASE_URL="postgres://${var.rds_master_username}:$DB_PW_ENC@${var.rds_address}:${var.rds_port}/${var.rds_db_name}"
    # ElastiCache has transit_encryption + AUTH on, so rediss:// + token.
    REDIS_URL="rediss://:$REDIS_TOKEN_ENC@${var.redis_primary_endpoint}:${var.redis_port}"

    install -d -m 0750 /etc/vidyouth
    umask 077
    cat > /etc/vidyouth/auth.env <<ENVEOF
    NODE_ENV=production
    PORT=8080
    LOG_LEVEL=info
    AWS_REGION=$REGION
    AWS_EMAIL_REGION=$REGION
    AWS_SMS_REGION=$REGION
    DATABASE_URL=$DATABASE_URL
    REDIS_URL=$REDIS_URL
    BCRYPT_PEPPER=$BCRYPT_PEPPER
    EMAIL_PROVIDER=${var.email_provider}
    SMS_PROVIDER=${var.sms_provider}
    EMAIL_FROM=${var.email_from}
    SES_FROM_EMAIL=${var.ses_from_email}
    APP_BASE_URL=${local.effective_app_base_url}
    OAUTH_SUCCESS_REDIRECT_URL=${local.effective_oauth_redirect}
    ENVEOF
    # PEM keys carry real newlines: append quoted so dotenv parses multiline.
    printf 'JWT_PRIVATE_KEY="%s"\n' "$JWT_PRIVATE_KEY" >> /etc/vidyouth/auth.env
    printf 'JWT_PUBLIC_KEY="%s"\n'  "$JWT_PUBLIC_KEY"  >> /etc/vidyouth/auth.env
    chmod 600 /etc/vidyouth/auth.env

    # 5. pull + run. If the tag is the placeholder we still try; failure
    #    is acceptable on first boot before the real image is pushed.
    #    The env file is mounted to /app/.env so the app's own dotenv loader
    #    parses it (handles the multiline PEM values).
    if docker pull "$IMAGE"; then
      docker stop auth || true
      docker rm   auth || true
      docker run -d --restart=always --name auth \
        -p 8080:8080 \
        -v /etc/vidyouth/auth.env:/app/.env:ro \
        "$IMAGE"
    fi

    # 6. minimal CloudWatch agent config: ship docker JSON logs to CW
    mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
    cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json <<JSON
    {
      "logs": {
        "logs_collected": {
          "files": {
            "collect_list": [
              {
                "file_path": "/var/lib/docker/containers/*/*.log",
                "log_group_name": "$LOG_GROUP",
                "log_stream_name": "{instance_id}",
                "timestamp_format": "%Y-%m-%dT%H:%M:%S.%fZ"
              }
            ]
          }
        }
      }
    }
    JSON
    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
      -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json -s
  EOT
  )
}

resource "aws_launch_template" "app" {
  name_prefix   = "${var.name_prefix}-app-"
  image_id      = data.aws_ssm_parameter.al2023_ami.value
  instance_type = local.ec2_instance_type

  iam_instance_profile {
    name = var.ec2_instance_profile_name
  }

  vpc_security_group_ids = [var.ec2_security_group_id]

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 2
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      encrypted             = true
      kms_key_id            = var.data_kms_arn
      delete_on_termination = true
    }
  }

  monitoring {
    enabled = true
  }

  user_data = local.user_data

  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "${var.name_prefix}-auth" })
  }

  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "${var.name_prefix}-auth-vol" })
  }

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "app" {
  name                = "${var.name_prefix}-auth-asg"
  vpc_zone_identifier = var.private_app_subnet_ids
  min_size            = local.asg_min
  desired_capacity    = local.asg_desired
  max_size            = local.asg_max

  launch_template {
    id      = aws_launch_template.app.id
    version = "$Latest"
  }

  health_check_type         = "ELB"
  health_check_grace_period = 180
  default_cooldown          = 180

  target_group_arns = [aws_lb_target_group.app.arn]

  termination_policies = ["OldestLaunchTemplate", "Default"]

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
      instance_warmup        = 180
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.name_prefix}-auth-asg"
    propagate_at_launch = true
  }

  dynamic "tag" {
    for_each = var.tags
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    create_before_destroy = true
    ignore_changes        = [desired_capacity]
  }
}

resource "aws_autoscaling_policy" "cpu_target" {
  name                      = "${var.name_prefix}-cpu50"
  autoscaling_group_name    = aws_autoscaling_group.app.name
  policy_type               = "TargetTrackingScaling"
  estimated_instance_warmup = 180

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = 50.0
  }
}
