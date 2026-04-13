/**
 * OpenTelemetry bootstrap for agent observability.
 *
 * Wire-up is intentionally minimal and lazy: if OTEL_EXPORTER_OTLP_ENDPOINT
 * is unset, tracing is a no-op (no collector required for dev).
 *
 * Span attributes always include tenant_id, writer_id, agent_session_id when
 * available. User message bodies are NEVER added to spans (PII + content
 * isolation).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { Resource } from '@opentelemetry/sdk-node/node_modules/@opentelemetry/resources';

let sdk: NodeSDK | null = null;

/** Call once at server start. No-ops if OTEL endpoint isn't configured. */
export function initTracing(): void {
  if (sdk) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    console.log('[tracing] OTEL_EXPORTER_OTLP_ENDPOINT not set — agent tracing disabled');
    return;
  }

  try {
    sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: 'deepfeedai-server',
        [SemanticResourceAttributes.SERVICE_VERSION]: process.env.APP_VERSION || 'dev',
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
    });
    sdk.start();
    console.log(`[tracing] agent tracing enabled → ${endpoint}`);
  } catch (err: any) {
    console.warn('[tracing] init failed:', err?.message);
    sdk = null;
  }
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {}
  sdk = null;
}
