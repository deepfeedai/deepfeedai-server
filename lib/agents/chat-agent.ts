/**
 * Chat Agent — LangGraph StateGraph that handles writer conversational messages.
 *
 * Flow:
 *   load_context → agent → (tools → agent)* → persist → END
 *
 * Iteration cap: MAX_ITERATIONS to prevent runaway tool loops.
 * Feature-flagged per tenant via settings.chat_agent_engine = 'langgraph'.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { v4 as uuidv4 } from 'uuid';

import { AIRouterChatModel } from './ai-router-chat-model';
import { buildTools, ToolContext } from './tools/index';

// CJS requires for existing JS modules
// eslint-disable-next-line @typescript-eslint/no-var-requires
const messagingCtx: any = require('../messaging/context');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildWriterPrompt } = require('../writer-assign');

const MAX_ITERATIONS = 5;

// ── State schema ─────────────────────────────────────────────────────

const ChatState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  writerId: Annotation<number>(),
  tenantId: Annotation<number>(),
  writerRole: Annotation<string>({ default: () => 'writer' }),
  contextKey: Annotation<string>(),
  userQuestion: Annotation<string>(),
  userId: Annotation<string | null>({ default: () => null }),
  userName: Annotation<string | null>({ default: () => null }),
  platform: Annotation<string>({ default: () => 'unknown' }),
  iterations: Annotation<number>({
    reducer: (a, b) => a + b,
    default: () => 0,
  }),
  agentSessionId: Annotation<string>(),
  writer: Annotation<any>(),
});

type ChatStateType = typeof ChatState.State;

// ── Nodes ────────────────────────────────────────────────────────────

async function loadContextNode(state: ChatStateType): Promise<Partial<ChatStateType>> {
  // Load persona, history, summary from existing tables
  const persona = await buildWriterPrompt(state.writer, state.tenantId);
  const history = (await messagingCtx.getHistory(state.contextKey, state.tenantId, state.writerId)) || [];
  const summary = await messagingCtx.getSummary(state.contextKey, state.tenantId).catch(() => null);

  const groundingRules =
    '\n\n## Grounding rules (REQUIRED)\n' +
    '- If the user asks what you have written, covered, or published: CALL searchArticles FIRST. Never fabricate article titles, topics, or links.\n' +
    '- If searchArticles returns empty, tell the user honestly you have not published articles on that topic (or at all yet). Offer to discuss the topic from curated sources or general knowledge instead.\n' +
    '- If the user asks for a specific link, the link MUST come from a tool result. No invented URLs.\n' +
    '- For questions about your beats or what you cover: call listWriterBeats.\n' +
    '- For questions about other writers\' coverage: call checkRecentColleagueWork.\n';

  const systemContent =
    [
      persona,
      summary ? `\nConversation summary so far:\n${summary}` : '',
      groundingRules,
    ]
      .filter(Boolean)
      .join('\n');

  const msgs: BaseMessage[] = [new SystemMessage(systemContent)];
  // Convert stored history (role/content pairs) to LangChain messages
  for (const turn of history.slice(-10)) {
    if (turn.role === 'user') msgs.push(new HumanMessage(turn.content));
    else if (turn.role === 'assistant') msgs.push(new AIMessage(turn.content));
  }
  msgs.push(new HumanMessage(state.userQuestion));

  return { messages: msgs };
}

function makeAgentNode(modelFactory: () => AIRouterChatModel, tools: any[]) {
  return async function agentNode(state: ChatStateType): Promise<Partial<ChatStateType>> {
    const model = modelFactory();
    // bindTools returns a new model instance with tools attached
    const modelWithTools = tools.length ? (model as any).bindTools(tools) : model;
    const response = await modelWithTools.invoke(state.messages);
    return {
      messages: [response],
      iterations: 1,
    };
  };
}

async function persistNode(state: ChatStateType): Promise<Partial<ChatStateType>> {
  const lastAi = [...state.messages].reverse().find(m => m instanceof AIMessage) as AIMessage | undefined;
  const responseText = lastAi ? stringifyContent(lastAi.content) : '';
  try {
    await messagingCtx.addTurn(
      state.contextKey,
      state.userQuestion,
      responseText,
      {
        tenantId: state.tenantId,
        writerId: state.writerId,
        userId: state.userId,
        platform: state.platform,
      },
    );
  } catch (err: any) {
    console.warn('[chat-agent] persist failed:', err.message);
  }
  return {};
}

function stringifyContent(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => (typeof p === 'string' ? p : ('text' in p ? (p as any).text : '')))
      .join('');
  }
  return String(content ?? '');
}

// Conditional edge: decide whether to go to tools or persist
function routeAfterAgent(state: ChatStateType): 'tools' | 'persist' {
  const last = state.messages[state.messages.length - 1];
  const toolCalls = (last as AIMessage)?.tool_calls || [];
  if (toolCalls.length && state.iterations < MAX_ITERATIONS) return 'tools';
  return 'persist';
}

// ── Public entry point ───────────────────────────────────────────────

export interface RunChatAgentOpts {
  writer: any;
  tenantId: number;
  question: string;
  contextKey: string;
  meta?: {
    userId?: string | null;
    userName?: string | null;
    platform?: string;
  };
}

export async function runChatAgent(opts: RunChatAgentOpts): Promise<string> {
  const { writer, tenantId, question, contextKey, meta = {} } = opts;
  const agentSessionId = uuidv4();

  const toolCtx: ToolContext = {
    tenantId,
    writerId: writer.id,
    writerRole: writer.role || 'writer',
    userId: meta.userId || null,
    userName: meta.userName || null,
    platform: meta.platform || 'unknown',
  };
  const tools = buildTools(toolCtx);

  // LLM factory — new instance per agent-node call, tenant in closure
  const modelFactory = () =>
    new AIRouterChatModel({
      tenantId,
      operation: 'chat',
      writerId: writer.id,
      agentSessionId,
      trigger: 'chat-agent',
      temperature: 0.7,
      maxTokens: 1024,
    });

  const graph = new StateGraph(ChatState)
    .addNode('load_context', loadContextNode)
    .addNode('agent', makeAgentNode(modelFactory, tools))
    .addNode('tools', new ToolNode(tools as any))
    .addNode('persist', persistNode)
    .addEdge(START, 'load_context')
    .addEdge('load_context', 'agent')
    .addConditionalEdges('agent', routeAfterAgent, { tools: 'tools', persist: 'persist' })
    .addEdge('tools', 'agent')
    .addEdge('persist', END);

  const app = graph.compile();

  const finalState = await app.invoke({
    writer,
    writerId: writer.id,
    tenantId,
    writerRole: writer.role || 'writer',
    contextKey,
    userQuestion: question,
    userId: meta.userId || null,
    userName: meta.userName || null,
    platform: meta.platform || 'unknown',
    agentSessionId,
  });

  const lastAi = [...finalState.messages].reverse().find(m => m instanceof AIMessage) as AIMessage | undefined;
  return lastAi ? stringifyContent(lastAi.content) : '';
}
