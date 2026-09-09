import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { KIRO_CONSTANTS } from '../constants.js'
import { isReasoningModel } from './effort.js'
import type { Effort, KiroAuthDetails } from './types'

/**
 * Cache key includes effort and the resolved model to ensure separate clients
 * per effort level and wire schema, since middleware is configured at client
 * creation time.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  effort?: Effort
  model?: string
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  model?: string
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${auth.email || 'default'}:${model || 'default'}:${effort || 'none'}`
  const cached = clientCache.get(cacheKey)

  if (
    cached &&
    cached.token === auth.access &&
    cached.effort === effort &&
    cached.model === model
  ) {
    return cached.client
  }

  const token = auth.access
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]]
  })

  // Add Kiro-specific headers
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  // Inject additionalModelRequestFields for effort-based thinking control.
  //
  // The wire schema differs by family (mirrors kirocc's BuildPayload):
  // - GPT-5.6 reasoning models   → { reasoning: { effort } }
  // - Claude / output_config     → { output_config: { effort } }
  // The two schemas are mutually exclusive per model; sending the wrong one
  // makes Kiro reject the request or silently ignore the effort.
  if (effort) {
    const reasoningStyle = model ? isReasoningModel(model) : false
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        // The SDK serializes input to args.input, we need to modify the body
        // before it's sent. The body is in args.request.body as a string.
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            body.additionalModelRequestFields = reasoningStyle
              ? { reasoning: { effort } }
              : { output_config: { effort } }
            args.request.body = JSON.stringify(body)
          } catch {
            // If body parsing fails, continue without modification
          }
        }
        return next(args)
      },
      { step: 'build', name: 'addEffortConfig', priority: 'high' }
    )
  }

  clientCache.set(cacheKey, { client, token, effort, model })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
