/**
 * OAuth / OIDC for Google and Microsoft — full flow.
 *
 *   GET  /auth/{provider}            → redirect to the provider consent screen
 *   GET  /auth/{provider}/callback   → exchange code, resolve the Vidyouth
 *                                       user, mint a session, hand tokens
 *                                       back to the frontend
 *
 * The state cookie (HttpOnly, SameSite=Lax, 10-min) is verified on callback
 * for CSRF protection. Identities are stored in user_identities keyed by the
 * provider's stable `sub` — never the email.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  findIdentityByProviderSubject,
  upsertIdentity,
  type IdentityProvider,
} from '../repositories/user-identities.js';
import {
  createUser,
  findActiveUserByEmail,
  findUserById,
  type UserRecord,
} from '../repositories/users.js';
import { createAuthenticatedSession } from '../services/auth-service.js';
import { recordAudit } from '../services/audit.js';
import {
  consumeOauthMfaChallenge,
  createOauthMfaChallenge,
  maskedMfaEmail,
} from '../services/oauth-mfa.js';

type Provider = IdentityProvider;

interface ProviderConfig {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  redirectUri?: string | undefined;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  scope: string;
}

interface OidcProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

const stateCookieName = (provider: Provider) => `vidyouth_oauth_${provider}_state`;

function missingConfig(provider: Provider, config: ProviderConfig): string[] {
  const missing: string[] = [];
  if (!config.clientId) missing.push(`${provider.toUpperCase()}_CLIENT_ID`);
  if (!config.clientSecret) missing.push(`${provider.toUpperCase()}_CLIENT_SECRET`);
  if (!config.redirectUri) missing.push(`${provider.toUpperCase()}_REDIRECT_URI`);
  return missing;
}

function setStateCookie(reply: FastifyReply, provider: Provider, state: string) {
  reply.header(
    'Set-Cookie',
    `${stateCookieName(provider)}=${state}; Path=/auth/${provider}/callback; HttpOnly; SameSite=Lax; Max-Age=600`,
  );
}

function clearStateCookie(reply: FastifyReply, provider: Provider) {
  reply.header(
    'Set-Cookie',
    `${stateCookieName(provider)}=; Path=/auth/${provider}/callback; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

function readStateCookie(req: FastifyRequest, provider: Provider): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const name = stateCookieName(provider);
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function buildAuthorizationUrl(config: ProviderConfig, state: string): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('client_id', config.clientId ?? '');
  url.searchParams.set('redirect_uri', config.redirectUri ?? '');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

function providerConfig(provider: Provider): ProviderConfig {
  if (provider === 'google') {
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_REDIRECT_URI,
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
    };
  }
  const tenant = env.MICROSOFT_TENANT_ID || 'common';
  return {
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    redirectUri: env.MICROSOFT_REDIRECT_URI,
    authorizationEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    userInfoEndpoint: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile',
  };
}

async function exchangeCodeForToken(
  config: ProviderConfig,
  code: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.clientId ?? '',
    client_secret: config.clientSecret ?? '',
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri ?? '',
  });
  const res = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`token_exchange_failed: ${res.status} ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('token_exchange_no_access_token');
  return json.access_token;
}

async function fetchProfile(
  config: ProviderConfig,
  accessToken: string,
): Promise<OidcProfile> {
  const res = await fetch(config.userInfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`userinfo_failed: ${res.status} ${detail.slice(0, 300)}`);
  }
  const u = (await res.json()) as Record<string, unknown>;
  const sub = String(u.sub ?? '');
  if (!sub) throw new Error('userinfo_no_sub');
  const email =
    typeof u.email === 'string' ? u.email.toLowerCase() : null;
  // Google returns email_verified as boolean; Microsoft Graph oidc omits it.
  const emailVerified =
    u.email_verified === true || u.email_verified === 'true';
  const name =
    (typeof u.name === 'string' && u.name) ||
    [u.given_name, u.family_name].filter(Boolean).join(' ').trim() ||
    null;
  const picture = typeof u.picture === 'string' ? u.picture : null;
  return { sub, email, emailVerified, name, picture };
}

async function resolveUser(
  provider: Provider,
  profile: OidcProfile,
): Promise<UserRecord> {
  // 1. Known identity → that user.
  const existing = await findIdentityByProviderSubject(provider, profile.sub);
  if (existing) {
    const user = await findUserById(existing.user_id);
    if (user) {
      await upsertIdentity({
        userId: user.id,
        provider,
        providerSubject: profile.sub,
        email: profile.email,
        emailVerified: profile.emailVerified,
        displayName: profile.name,
        avatarUrl: profile.picture,
      });
      return user;
    }
  }

  // 2. No identity yet — link to an existing account by verified email,
  //    otherwise create a fresh student account.
  let user: UserRecord | null = profile.email
    ? await findActiveUserByEmail(profile.email)
    : null;

  if (!user) {
    user = await createUser({
      role: 'student',
      email: profile.email,
      displayName: profile.name,
    });
  }

  await upsertIdentity({
    userId: user.id,
    provider,
    providerSubject: profile.sub,
    email: profile.email,
    emailVerified: profile.emailVerified,
    displayName: profile.name,
    avatarUrl: profile.picture,
  });

  return user;
}

function successRedirect(
  reply: FastifyReply,
  tokens: { access_token: string; refresh_token: string; expires_in: number },
) {
  // Tokens travel in the URL fragment so they never hit the server log /
  // referer. The frontend (login.html / newhome.html) reads the hash on
  // load, stores them in localStorage, and strips the fragment.
  const base = env.OAUTH_SUCCESS_REDIRECT_URL.replace(/#.*$/, '');
  const frag =
    `#access_token=${encodeURIComponent(tokens.access_token)}` +
    `&refresh_token=${encodeURIComponent(tokens.refresh_token)}` +
    `&token_type=Bearer&expires_in=${tokens.expires_in}`;
  reply.redirect(`${base}${frag}`);
}

function mfaRedirect(
  reply: FastifyReply,
  challenge: { token: string; email: string; expiresInSec: number; provider: Provider },
) {
  const base = env.OAUTH_SUCCESS_REDIRECT_URL.replace(/#.*$/, '').replace(
    /\/[^/]*$/,
    '/verify.html',
  );
  const frag =
    '#oauth_mfa_required=true' +
    `&mfa_token=${encodeURIComponent(challenge.token)}` +
    `&provider=${encodeURIComponent(challenge.provider)}` +
    `&email=${encodeURIComponent(maskedMfaEmail(challenge.email))}` +
    `&expires_in=${challenge.expiresInSec}`;
  reply.redirect(`${base}${frag}`);
}

function failRedirect(reply: FastifyReply, reason: string) {
  const base = env.OAUTH_SUCCESS_REDIRECT_URL.replace(/#.*$/, '').replace(
    /\/[^/]*$/,
    '/login.html',
  );
  reply.redirect(`${base}#oauth_error=${encodeURIComponent(reason)}`);
}

async function startOauth(app: FastifyInstance, provider: Provider): Promise<void> {
  app.get(`/auth/${provider}`, async (_req, reply) => {
    const config = providerConfig(provider);
    const missing = missingConfig(provider, config);
    if (missing.length > 0) {
      reply.code(501).send({
        error: 'oauth_not_configured',
        provider,
        missing,
        message: `Add ${missing.join(', ')} in app/.env, then restart the API.`,
      });
      return;
    }
    const state = randomBytes(24).toString('hex');
    setStateCookie(reply, provider, state);
    reply.redirect(buildAuthorizationUrl(config, state));
  });

  app.get(`/auth/${provider}/callback`, async (req, reply) => {
    const q = req.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    if (q.error) {
      await recordAudit({
        action: 'login.failed',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { provider, reason: q.error_description ?? q.error },
        succeeded: false,
      });
      failRedirect(reply, q.error_description ?? q.error);
      return;
    }

    const config = providerConfig(provider);
    if (missingConfig(provider, config).length > 0) {
      reply.code(501).send({ error: 'oauth_not_configured', provider });
      return;
    }

    // CSRF: the state echoed back must match the HttpOnly cookie we set.
    const cookieState = readStateCookie(req, provider);
    clearStateCookie(reply, provider);
    if (!q.state || !cookieState || q.state !== cookieState) {
      await recordAudit({
        action: 'login.failed',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { provider, reason: 'state_mismatch' },
        succeeded: false,
      });
      failRedirect(reply, 'state_mismatch');
      return;
    }

    if (!q.code) {
      failRedirect(reply, 'missing_code');
      return;
    }

    try {
      const accessToken = await exchangeCodeForToken(config, q.code);
      const profile = await fetchProfile(config, accessToken);
      const user = await resolveUser(provider, profile);

      if (env.OAUTH_MFA_ENABLED) {
        if (!profile.email) {
          await recordAudit({
            userId: user.id,
            action: 'oauth.mfa.failed',
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            meta: { provider, reason: 'missing_email' },
            succeeded: false,
          });
          failRedirect(reply, 'oauth_mfa_email_required');
          return;
        }

        const challenge = await createOauthMfaChallenge({
          user,
          provider,
          providerSubject: profile.sub,
          email: profile.email,
          logger: req.log,
        });
        await recordAudit({
          userId: user.id,
          action: 'oauth.mfa.requested',
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          meta: { provider, identity: profile.sub },
          succeeded: true,
        });
        mfaRedirect(reply, challenge);
        return;
      }

      const session = await createAuthenticatedSession({
        user,
        auditAction: 'login.success',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      await recordAudit({
        userId: user.id,
        action: 'login.success',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { provider, identity: profile.sub },
        succeeded: true,
      });

      successRedirect(reply, {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
      });
    } catch (err) {
      req.log.error({ err, provider }, 'oauth callback failed');
      await recordAudit({
        action: 'login.failed',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { provider, reason: (err as Error).message.slice(0, 200) },
        succeeded: false,
      });
      failRedirect(reply, 'oauth_exchange_failed');
    }
  });
}

const mfaVerifyBody = z.object({
  mfa_token: z.string().min(32).max(128),
  code: z.string().regex(/^\d{4,8}$/),
});

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/oauth/mfa/verify', async (req, reply) => {
    const parsed = mfaVerifyBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request' });
      return;
    }

    const challenge = await consumeOauthMfaChallenge({
      token: parsed.data.mfa_token,
      code: parsed.data.code,
    });
    if (!challenge) {
      await recordAudit({
        action: 'oauth.mfa.failed',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { reason: 'invalid_or_expired_code' },
        succeeded: false,
      });
      reply.code(401).send({ error: 'invalid_or_expired_mfa_code' });
      return;
    }

    const user = await findUserById(challenge.userId);
    if (!user || !user.is_active) {
      await recordAudit({
        userId: challenge.userId,
        action: 'oauth.mfa.failed',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { provider: challenge.provider, reason: 'inactive_or_missing_user' },
        succeeded: false,
      });
      reply.code(401).send({ error: 'invalid_credentials' });
      return;
    }

    const session = await createAuthenticatedSession({
      user,
      auditAction: 'login.success',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    await recordAudit({
      userId: user.id,
      action: 'oauth.mfa.verified',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: {
        provider: challenge.provider,
        identity: challenge.providerSubject,
      },
      succeeded: true,
    });

    reply.send({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      token_type: session.token_type,
      expires_in: session.expires_in,
    });
  });

  await startOauth(app, 'google');
  await startOauth(app, 'microsoft');
}
