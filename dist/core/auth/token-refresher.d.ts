import type { AccountRepository } from '../../infrastructure/database/account-repository.js';
import type { AccountManager } from '../../plugin/accounts.js';
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types.js';
type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void;
interface TokenRefresherConfig {
    token_expiry_buffer_ms: number;
    auto_sync_kiro_cli: boolean;
    account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage';
}
export declare class TokenRefresher {
    private config;
    private accountManager;
    private syncFromKiroCli;
    private repository;
    private static locks;
    constructor(config: TokenRefresherConfig, accountManager: AccountManager, syncFromKiroCli: () => Promise<void>, repository: AccountRepository);
    refreshIfNeeded(account: ManagedAccount, auth: KiroAuthDetails, showToast: ToastFunction): Promise<{
        account: ManagedAccount;
        shouldContinue: boolean;
    }>;
    forceRefresh(account: ManagedAccount, auth: KiroAuthDetails): Promise<{
        account: ManagedAccount;
        success: boolean;
        changed: boolean;
    }>;
    /** Ensures only one refresh/recovery flow runs per account at a time; late
     *  callers await and adopt the in-flight operation's outcome instead of
     *  racing it with a second network exchange of the same refresh token. */
    private runExclusive;
    private performOidcRefresh;
    private performForceRefresh;
    private handleRefreshError;
}
export {};
