import type { AccountRepository } from '../../infrastructure/database/account-repository.js';
import type { AccountManager } from '../../plugin/accounts.js';
import type { KiroConfig } from '../../plugin/config/index.js';
type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void;
export declare class RequestHandler {
    private accountManager;
    private config;
    private repository;
    private client?;
    private accountSelector;
    private tokenRefresher;
    private errorHandler;
    private responseHandler;
    private usageTracker;
    private retryStrategy;
    private reauthInFlight;
    private lastFailedReauthAt;
    private static kiroRequestQueue;
    constructor(accountManager: AccountManager, config: KiroConfig, repository: AccountRepository, client?: any | undefined);
    handle(input: any, init: any, showToast: ToastFunction): Promise<Response>;
    private enqueueKiroRequest;
    private handleKiroRequest;
    private extractModel;
    private prepareSdkRequest;
    private handleSuccessfulRequest;
    private logSdkRequest;
    private logSdkResponse;
    private logSdkError;
    private triggerReauth;
    private performReauth;
    /**
     * Non-interactive recovery attempted before ever opening a browser for
     * device-code auth. A refresh may have already succeeded and persisted
     * fresh credentials (e.g. from a concurrent startup usage refresh, or from
     * Kiro CLI) that the in-memory AccountManager hasn't picked up yet. This
     * reloads the repository, re-syncs Kiro CLI if enabled, reconciles any
     * recovered accounts into memory (without writing them back), and tries a
     * refresh for any account that still looks unhealthy. Returns true if at
     * least one account became usable, so the caller can retry the request
     * loop instead of falling through to interactive OAuth.
     */
    private attemptNonInteractiveRecovery;
    private hasUsableAccount;
    private allAccountsPermanentlyUnhealthy;
    private sleep;
}
export {};
