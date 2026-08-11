import { accessTokenExpired } from '../../kiro/auth.js';
import { KiroTokenRefreshError } from '../../plugin/errors.js';
import * as logger from '../../plugin/logger.js';
import { refreshAccessToken } from '../../plugin/token.js';
export class TokenRefresher {
    config;
    accountManager;
    syncFromKiroCli;
    repository;
    // Shared across every TokenRefresher instance (startup usage refresh and the
    // per-request refresher each construct their own instance) so a rotating
    // refresh token is never exchanged twice concurrently for the same account.
    // A second concurrent exchange with the old token would fail with
    // invalid_grant and could mark a perfectly healthy account permanently
    // unhealthy right after a sibling call already rotated it successfully.
    static locks = new Map();
    constructor(config, accountManager, syncFromKiroCli, repository) {
        this.config = config;
        this.accountManager = accountManager;
        this.syncFromKiroCli = syncFromKiroCli;
        this.repository = repository;
    }
    async refreshIfNeeded(account, auth, showToast) {
        if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
            return { account, shouldContinue: false };
        }
        const result = await this.runExclusive(account.id, () => this.performOidcRefresh(account, auth, showToast));
        return { account: result.account, shouldContinue: !result.directRefresh };
    }
    async forceRefresh(account, auth) {
        const before = account.accessToken;
        const result = await this.runExclusive(account.id, () => this.performForceRefresh(account, auth));
        return {
            account: result.account,
            success: result.usable,
            changed: result.account.accessToken !== before
        };
    }
    /** Ensures only one refresh/recovery flow runs per account at a time; late
     *  callers await and adopt the in-flight operation's outcome instead of
     *  racing it with a second network exchange of the same refresh token. */
    async runExclusive(accountId, factory) {
        const existing = TokenRefresher.locks.get(accountId);
        if (existing) {
            return existing;
        }
        const promise = factory().finally(() => {
            if (TokenRefresher.locks.get(accountId) === promise) {
                TokenRefresher.locks.delete(accountId);
            }
        });
        TokenRefresher.locks.set(accountId, promise);
        return promise;
    }
    async performOidcRefresh(account, auth, showToast) {
        try {
            const newAuth = await refreshAccessToken(auth);
            this.accountManager.updateFromAuth(account, newAuth);
            // Persist only the updated account instead of all accounts — avoids
            // invalidating the whole AccountCache on every token refresh.
            await this.repository.save(account);
            return { account, directRefresh: true, usable: true };
        }
        catch (e) {
            return await this.handleRefreshError(e, account, showToast);
        }
    }
    async performForceRefresh(account, auth) {
        if (this.config.auto_sync_kiro_cli) {
            try {
                await this.syncFromKiroCli();
            }
            catch (e) {
                logger.warn('Force refresh: Kiro CLI sync failed', {
                    message: e instanceof Error ? e.message : String(e)
                });
            }
        }
        this.repository.invalidateCache();
        const accounts = await this.repository.findAll();
        const synced = accounts.find((a) => a.id === account.id);
        if (synced &&
            synced.accessToken !== account.accessToken &&
            !accessTokenExpired(this.accountManager.toAuthDetails(synced), this.config.token_expiry_buffer_ms)) {
            this.accountManager.updateFromAuth(account, this.accountManager.toAuthDetails(synced));
            await this.repository.batchSave(this.accountManager.getAccounts());
            logger.debug('Force refresh: recovered newer token from CLI sync');
            return { account, directRefresh: false, usable: true };
        }
        try {
            const newAuth = await refreshAccessToken(auth);
            this.accountManager.updateFromAuth(account, newAuth);
            await this.repository.batchSave(this.accountManager.getAccounts());
            logger.debug('Force refresh: token refreshed via OIDC');
            return { account, directRefresh: true, usable: true };
        }
        catch (e) {
            logger.warn('Force refresh failed', {
                message: e instanceof Error ? e.message : String(e)
            });
            return { account, directRefresh: false, usable: false };
        }
    }
    async handleRefreshError(error, account, showToast) {
        logger.error('Token refresh failed', {
            email: account.email,
            code: error instanceof KiroTokenRefreshError ? error.code : undefined,
            message: error instanceof Error ? error.message : String(error)
        });
        if (this.config.auto_sync_kiro_cli) {
            try {
                await this.syncFromKiroCli();
            }
            catch (e) {
                logger.warn('Token refresh recovery: Kiro CLI sync failed', {
                    message: e instanceof Error ? e.message : String(e)
                });
            }
        }
        this.repository.invalidateCache();
        const accounts = await this.repository.findAll();
        const stillAcc = accounts.find((a) => a.id === account.id);
        if (stillAcc &&
            !accessTokenExpired(this.accountManager.toAuthDetails(stillAcc), this.config.token_expiry_buffer_ms)) {
            this.accountManager.addAccount(stillAcc);
            showToast('Credentials recovered from Kiro CLI sync.', 'info');
            return { account: stillAcc, directRefresh: false, usable: true };
        }
        if (error instanceof KiroTokenRefreshError &&
            (error.code === 'ExpiredTokenException' ||
                error.code === 'InvalidTokenException' ||
                error.code === 'ExpiredClientException' ||
                error.code === 'HTTP_401' ||
                error.code === 'HTTP_403' ||
                error.message.includes('Invalid refresh token provided') ||
                error.message.includes('Invalid grant provided') ||
                error.message.includes('Client is expired'))) {
            this.accountManager.markUnhealthy(account, error.code || error.message);
            await this.repository.batchSave(this.accountManager.getAccounts());
            return { account, directRefresh: false, usable: false };
        }
        logger.error('Token refresh unrecoverable', {
            email: account.email,
            code: error instanceof KiroTokenRefreshError ? error.code : undefined,
            message: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}
