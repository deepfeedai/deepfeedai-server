/**
 * AIRouterChatModel — LangChain BaseChatModel that delegates to our ai-router.
 *
 * This wrapper is the seam between LangGraph agents and our internal LLM
 * routing layer. All tenant-scoped concerns (BYAI, budget gating, provider
 * fallback, usage logging with agent_session_id) stay in ai-router.complete().
 *
 * Instantiated PER REQUEST with tenant context in closure — never cached at
 * module level, because tenantId/writerId/agentSessionId are part of its
 * identity.
 */
import { BaseChatModel, BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { ChatGeneration, ChatResult } from '@langchain/core/outputs';
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { Runnable } from '@langchain/core/runnables';
import { StructuredToolInterface } from '@langchain/core/tools';
import { BaseLanguageModelCallOptions } from '@langchain/core/language_models/base';

// ai-router is JS; we import via require() to keep its CJS contract.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const aiRouter: any = require('../ai-router');

export interface AIRouterChatModelParams extends BaseChatModelParams {
  tenantId: number;
  operation: string;                // maps to OPERATION_TIERS in chat-provider.js
  writerId?: number;
  agentSessionId?: string;
  trigger?: string;
  articleSlug?: string;
  temperature?: number;
  maxTokens?: number;
  providerOverride?: string;
  modelOverride?: string;
}

/** Our internal tool-call shape returned by ai-router. */
interface RouterToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface RouterUnifiedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Convert LangChain messages to the `{ role, content }` shape ai-router expects. */
function toRouterMessages(messages: BaseMessage[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (const m of messages) {
    if (m instanceof SystemMessage) {
      out.push({ role: 'system', content: stringifyContent(m.content) });
    } else if (m instanceof HumanMessage) {
      out.push({ role: 'user', content: stringifyContent(m.content) });
    } else if (m instanceof AIMessage) {
      // If this AI message was a tool-calling turn, serialize both the text and a
      // reference to the tool calls so the next iteration has context.
      const aiText = stringifyContent(m.content);
      const toolCalls = (m.additional_kwargs?.tool_calls as RouterToolCall[] | undefined) || [];
      if (toolCalls.length) {
        const toolSummary = toolCalls
          .map(tc => `[called tool ${tc.name}(${JSON.stringify(tc.args)})]`)
          .join('\n');
        out.push({ role: 'assistant', content: aiText ? `${aiText}\n${toolSummary}` : toolSummary });
      } else {
        out.push({ role: 'assistant', content: aiText });
      }
    } else if (m instanceof ToolMessage) {
      // Tool results become user messages tagged with the tool name — keeps
      // provider compatibility without relying on provider-specific tool-result
      // formats (Anthropic vs OpenAI differ).
      out.push({
        role: 'user',
        content: `[tool:${m.name || m.tool_call_id}] ${stringifyContent(m.content)}`,
      });
    } else {
      // Fallback for unknown message types
      out.push({ role: 'user', content: stringifyContent(m.content) });
    }
  }
  return out;
}

function stringifyContent(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : ('text' in part ? (part as any).text : JSON.stringify(part))))
      .join('');
  }
  return String(content ?? '');
}

/** Convert a LangChain StructuredTool to our unified schema. */
function toRouterTool(tool: StructuredToolInterface): RouterUnifiedTool {
  // LangChain tools expose a `schema` (zod). We approximate JSON Schema by
  // reading the description text and letting providers' adapters receive
  // whatever parameters shape is attached. In practice, our tools file
  // emits JSON Schema directly via zodToJsonSchema — we just pass it through.
  const params = (tool as any).schema?._def ? zodLikeToJsonSchema(tool as any) : { type: 'object', properties: {} };
  return {
    name: tool.name,
    description: tool.description || '',
    parameters: params,
  };
}

function zodLikeToJsonSchema(tool: StructuredToolInterface): Record<string, unknown> {
  // If the tool stored a pre-built JSON schema on itself, prefer it.
  if ((tool as any).lc_kwargs?.jsonSchema) return (tool as any).lc_kwargs.jsonSchema;
  if ((tool as any).jsonSchema) return (tool as any).jsonSchema;
  // Fallback: treat as open object — better to under-constrain than error out.
  return { type: 'object', properties: {}, additionalProperties: true };
}

export class AIRouterChatModel extends BaseChatModel {
  tenantId: number;
  operation: string;
  writerId?: number;
  agentSessionId?: string;
  trigger: string;
  articleSlug?: string;
  temperature: number;
  maxTokens: number;
  providerOverride?: string;
  modelOverride?: string;
  boundTools?: RouterUnifiedTool[];

  constructor(params: AIRouterChatModelParams) {
    super(params);
    this.tenantId = params.tenantId;
    this.operation = params.operation;
    this.writerId = params.writerId;
    this.agentSessionId = params.agentSessionId;
    this.trigger = params.trigger || 'chat-agent';
    this.articleSlug = params.articleSlug;
    this.temperature = params.temperature ?? 0.7;
    this.maxTokens = params.maxTokens ?? 2048;
    this.providerOverride = params.providerOverride;
    this.modelOverride = params.modelOverride;
  }

  _llmType(): string {
    return 'deepfeed-ai-router';
  }

  /**
   * LangGraph's createReactAgent / ToolNode uses bindTools() to give the model
   * a tool manifest. Store them for use in the next _generate call.
   */
  override bindTools(
    tools: StructuredToolInterface[],
    _kwargs?: Partial<BaseLanguageModelCallOptions>,
  ): Runnable<BaseMessage[], AIMessageChunk> {
    const cloned = new AIRouterChatModel({
      tenantId: this.tenantId,
      operation: this.operation,
      writerId: this.writerId,
      agentSessionId: this.agentSessionId,
      trigger: this.trigger,
      articleSlug: this.articleSlug,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      providerOverride: this.providerOverride,
      modelOverride: this.modelOverride,
    });
    cloned.boundTools = tools.map(toRouterTool);
    return cloned as unknown as Runnable<BaseMessage[], AIMessageChunk>;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const routerMessages = toRouterMessages(messages);
    const result = await aiRouter.complete({
      operation: this.operation,
      tenantId: this.tenantId,
      messages: routerMessages,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      trigger: this.trigger,
      articleSlug: this.articleSlug,
      writerId: this.writerId,
      agentSessionId: this.agentSessionId,
      providerOverride: this.providerOverride,
      modelOverride: this.modelOverride,
      tools: this.boundTools,
    });

    // ai-router returns null when budget gate denies the call.
    if (!result) {
      throw new Error('ai-router: budget denied or unavailable');
    }

    const toolCalls = (result.toolCalls || []) as RouterToolCall[];
    const aiMessage = new AIMessage({
      content: result.text || '',
      additional_kwargs: toolCalls.length ? { tool_calls: toolCalls.map(tc => ({
        id: tc.id, type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })) } : {},
      // LangChain's tool-using agents read this canonical property:
      tool_calls: toolCalls.length
        ? toolCalls.map(tc => ({ id: tc.id, name: tc.name, args: tc.args, type: 'tool_call' as const }))
        : undefined,
    });

    const generation: ChatGeneration = {
      text: result.text || '',
      message: aiMessage,
      generationInfo: {
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      },
    };

    return {
      generations: [generation],
      llmOutput: {
        tokenUsage: {
          promptTokens: result.usage?.promptTokens,
          completionTokens: result.usage?.completionTokens,
          cachedPromptTokens: result.usage?.cachedPromptTokens,
        },
        provider: result.provider,
        model: result.model,
      },
    };
  }
}
