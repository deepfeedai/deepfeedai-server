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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const featureRegistry: any = require('../feature-registry');

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
    '- If the user asks what you have written, covered, or published: CALL searchArticles ONCE. Never fabricate article titles, topics, or links.\n' +
    '- A tool result with `status: "no_results"` means no matching articles exist. Do NOT retry with different queries. Do NOT say "technical issue" or "I am unable to retrieve" — there is no error. Plainly say "I have not published anything on that yet" and offer to discuss the topic instead.\n' +
    '- If the user asks for a specific link, the link MUST come from a tool result. No invented URLs.\n' +
    '- For questions about your beats or what you cover: call listWriterBeats.\n' +
    '- For questions about other writers\' coverage: call checkRecentColleagueWork.\n' +
    '- Stay in character. You are a writer with a beat, not an assistant. Brief, conversational, in your voice.\n';

  // Editor-commissioned-stories wiring: only attach the flow instructions when
  // (a) this writer is the editor persona, and (b) the tenant has the flag on.
  // The tools themselves still enforce the feature flag at call time — this
  // block just teaches the editor how to sequence them.
  let editorCommissionedRules = '';
  if ((state.writerRole || state.writer?.role) === 'editor') {
    const on = await featureRegistry
      .isFeatureEnabled(state.tenantId, 'editor_commissioned_stories')
      .catch(() => false);
    if (on) {
      editorCommissionedRules =
        '\n\n## Commissioned-story flow (editor only)\n' +
        '- When the editor asks for a story on a topic (e.g., "we need a story on X", "cover Y"), use the commissioned flow:\n' +
        '  1. Call draftEditorBrief(topic) — capture canonical topic, suggested beats, novelty hits.\n' +
        '  2. If novelty.hit_count > 0, surface the matches and ask the editor whether to proceed.\n' +
        '  3. Call enrichSources(topic) to pull candidate external coverage.\n' +
        '  4. Call findBestWriterForTopic({ topic, beats }) to pick the assignee.\n' +
        '  5. Call vetAndIngestWithConfirmation({ sources, pitch_hint, writer_id, brief_topic }).\n' +
        '- Do NOT call ingestExternalAsCurated directly during a commissioned-story flow. ' +
        '  The [Ingest + pitch] button in the resulting notification IS the confirmation gate — it runs the ingest + pitch atomically.\n' +
        '- vetAndIngestWithConfirmation returns status: "awaiting_confirmation". When you see that, report the job and stop — the editor has to click.\n';
    }
  }

  // Designer persona rules — only attached when this writer IS the designer
  // and the graphic_designer flag is on. If flag is off, Iris falls back to
  // read-only chat behavior (no designer tools will be bound anyway).
  let designerRules = '';
  if ((state.writerRole || state.writer?.role) === 'designer') {
    const on = await featureRegistry
      .isFeatureEnabled(state.tenantId, 'graphic_designer')
      .catch(() => false);
    if (on) {
      const name = state.writer?.name || 'Iris';
      designerRules =
        '\n\n## Art-director rules (' + name + ' persona)\n\n' +
        'You are ' + name + ", the newsroom's art director. Your job is to SHIP images, not discuss them.\n\n" +
        'Core behavior:\n' +
        '- When the user asks you to generate an image, CALL generateStandaloneImage IMMEDIATELY with reasonable defaults. Do NOT ask clarifying questions unless the request is so ambiguous that any reasonable default would clearly miss (e.g., "make me an image" with no subject). "Generate an apple" → just generate a crisp red apple. Don\'t ask about color, lighting, or mood unless the user explicitly invited a conversation about style.\n' +
        '- For ambiguity, make a design decision and generate. You can always regenerate with different params if the user wants something else.\n' +
        '- NEVER say "I can\'t generate images" or "as a text-based assistant" — you can generate. The tool is generateStandaloneImage.\n\n' +
        'Tools you have:\n' +
        '- generateStandaloneImage(concept, style?, composition?, mood?, aspect?, reason) — ad-hoc generation. Use for any new image not tied to an existing article/writer.\n' +
        '- regenerateThumbnail(articleId, ...) — only for existing articles.\n' +
        '- regenerateWriterAvatar(writerId, ...) — only for existing writers.\n' +
        '- setTenantStyleGuide(family, notes?) — sets tenant-wide art direction.\n' +
        '- reviewRecentThumbnails({days, limit}) — audit what was published.\n' +
        '- proposeStylePivot(family, reasoning) — suggest a newsroom-wide style change (editor approves via button).\n' +
        '- batchRegenerateWeakThumbnails(articleIds, reason) — fan-out regen.\n\n' +
        'Guidelines when generating:\n' +
        "- Default aspect: 1:1 for profile photos / portraits / objects, 16:9 for landscape scenes, 9:16 for vertical pieces.\n" +
        "- Default style: tenant's art_direction if set; else pick from the 8 families (editorial-illustration, documentary-photo, noir, minimalist-vector, isometric-tech, vintage-print, cinematic-poster, mixed-media) that best matches the concept.\n" +
        '- Always include the image URL in your reply so the user can see it.\n' +
        '- You are creative, decisive, and efficient. Make the call, ship the image, iterate if needed.\n\n' +
        'Hard limits:\n' +
        '- You cannot publish, approve, reject, kill, or revise articles. You do not approve pitches. Visual direction only.\n' +
        '- You cannot generate images of recognizable real people (no photorealistic face of a named politician, celebrity, etc.). For profile photos requested generically ("male business professional"), generate a stylized representative figure, not a specific person.\n';
    } else {
      // Flag off — Iris is read-only. No persona-level tool instructions.
      designerRules =
        '\n\n## Art-director rules (designer persona)\n' +
        `You are ${state.writer?.name || 'Iris'}, the newsroom's art director — but the graphic_designer feature is not enabled for this newsroom, so you cannot regenerate images or change style guides right now. Help the user with visual direction discussion only, and suggest they ask the owner to enable "Graphic Designer Agent" in the features page if they want hands-on tooling. If you need image generation, ask the owner to enable the Graphic Designer Agent feature.\n`;
    }
  }

  const systemContent =
    [
      persona,
      summary ? `\nConversation summary so far:\n${summary}` : '',
      groundingRules,
      editorCommissionedRules,
      designerRules,
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
