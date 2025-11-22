require('dotenv').config();
const express = require('express');
const { SessionsClient, IntentsClient } = require('@google-cloud/dialogflow');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// Dialogflow configuration
const dialogflowConfig = {
  projectId: process.env.DIALOGFLOW_PROJECT_ID,
  credentials: {
    client_email: process.env.DIALOGFLOW_CLIENT_EMAIL,
    private_key: process.env.DIALOGFLOW_PRIVATE_KEY.replace(/\\n/g, '\n')
  }
};

const sessionClient = new SessionsClient(dialogflowConfig);
const intentsClient = new IntentsClient(dialogflowConfig);
const projectId = process.env.DIALOGFLOW_PROJECT_ID;

// Storage
const sessions = new Map();
const decisionLogs = [];
const chatHistories = new Map();
const MAX_HISTORY_LENGTH = 10;

// Intent Metadata Store
const INTENT_METADATA_FILE = './intent_metadata.json';
let intentMetadata = {};

function loadIntentMetadata() {
  try {
    if (fs.existsSync(INTENT_METADATA_FILE)) {
      intentMetadata = JSON.parse(fs.readFileSync(INTENT_METADATA_FILE, 'utf8'));
      console.log(`📚 Loaded metadata for ${Object.keys(intentMetadata).length} intents`);
    }
  } catch (err) {
    intentMetadata = {};
  }
}

function saveIntentMetadata() {
  try {
    fs.writeFileSync(INTENT_METADATA_FILE, JSON.stringify(intentMetadata, null, 2));
  } catch (err) {
    console.error('Error saving metadata:', err);
  }
}

loadIntentMetadata();

const PROTECTED_INTENTS = ['Default Welcome Intent', 'Default Fallback Intent'];

// Context-dependent patterns - NEVER save these
const CONTEXT_DEPENDENT_PATTERNS = [
  /^(yes|yeah|yep|yup|no|nope|nah|sure|okay|ok|alright)\.?$/i,
  /^(again|repeat|more|continue|go on|next|another)\.?$/i,
  /^(that|this|it|those|these)$/i,
  /(do it|do that|say it) again/i,
  /tell me more/i,
  /what about (it|that|this)/i,
  /^(why|how|when|where|what)\?*$/i,
  /^(hit|stand|fold|call|raise|spin|roll|flip|draw)\.?$/i,
];

// LOW REUSABILITY patterns - things that should NOT become intents
const LOW_REUSABILITY_PATTERNS = [
  // Personal/specific data
  /\b(my|mine|i|me|we|our)\b.*\b(account|order|password|email|phone|address|name)\b/i,
  /\b(order|account|ticket|booking)\s*#?\s*\d+/i,
  /\b(call|text|email|contact)\s+(my|the)?\s*(mom|dad|friend|boss|wife|husband)/i,
  
  // Time-specific one-time requests
  /\b(today|tomorrow|yesterday|tonight|this morning|last night)\b/i,
  /\b(book|schedule|reserve|set)\b.*\b(appointment|meeting|reservation|reminder)\b/i,
  
  // Greetings & small talk (already handled)
  /^(hi|hello|hey|good morning|good night|bye|goodbye|thanks|thank you)\.?$/i,
  /^(how are you|how's it going|what's up|sup)\.?$/i,
  
  // Games & entertainment
  /\b(play|let's play|start|begin)\b.*\b(game|trivia|quiz|riddle|joke)\b/i,
  /\b(tell me a|give me a)\s*(joke|riddle|story|fact)\b/i,
  
  // Very short or vague
  /^.{1,10}$/,  // Less than 10 chars
  /^(test|testing|asdf|aaa|hello?|hi?|ok|k)$/i,
  
  // Opinion/preference questions (subjective)
  /\b(best|favorite|worst|should i|do you think|what do you prefer)\b/i,
  
  // Current events (changes frequently)
  /\b(news|latest|recent|current|trending|today's)\b/i,
];

// HIGH REUSABILITY patterns - things that SHOULD become intents
const HIGH_REUSABILITY_PATTERNS = [
  // Factual knowledge questions
  /^what is\s+[a-z\s]+\??$/i,
  /^how does\s+[a-z\s]+\s+work\??$/i,
  /^explain\s+[a-z\s]+$/i,
  /^define\s+[a-z\s]+$/i,
  
  // How-to questions (general)
  /^how (do|can|to)\s+[a-z\s]+\??$/i,
  
  // General knowledge
  /\b(what|who|where|when|why|how)\b.*\b(invented|discovered|created|founded|started)\b/i,
  /\b(capital|population|president|ceo|founder)\s+of\b/i,
  
  // Technical/educational
  /\b(difference between|compare|vs|versus)\b/i,
  /\b(example|examples) of\b/i,
  /\b(benefits|advantages|disadvantages|pros|cons) of\b/i,
];

function isContextDependent(msg) {
  const t = msg.trim().toLowerCase();
  for (const p of CONTEXT_DEPENDENT_PATTERNS) {
    if (p.test(t)) return true;
  }
  return false;
}

// Pre-check reusability before even calling Groq
function preCheckReusability(message) {
  const msg = message.trim().toLowerCase();
  
  // Check LOW reusability patterns
  for (const p of LOW_REUSABILITY_PATTERNS) {
    if (p.test(msg)) {
      return { shouldSave: false, reason: 'Matches low-reusability pattern', score: 2 };
    }
  }
  
  // Check HIGH reusability patterns
  for (const p of HIGH_REUSABILITY_PATTERNS) {
    if (p.test(msg)) {
      return { shouldSave: true, reason: 'Matches high-reusability pattern', score: 8 };
    }
  }
  
  // Default: let Groq decide but with skepticism
  return { shouldSave: null, reason: 'Needs Groq analysis', score: 5 };
}

// Get ALL intents from Dialogflow
async function getAllIntentsWithDetails() {
  try {
    const projectAgentPath = intentsClient.projectAgentPath(projectId);
    const [intents] = await intentsClient.listIntents({ 
      parent: projectAgentPath,
      intentView: 'INTENT_VIEW_FULL'
    });
    
    return intents
      .filter(intent => !PROTECTED_INTENTS.includes(intent.displayName))
      .map(intent => ({
        name: intent.name,
        displayName: intent.displayName,
        trainingPhrases: intent.trainingPhrases?.map(tp => 
          tp.parts.map(p => p.text).join('')
        ) || [],
        responses: intent.messages?.[0]?.text?.text || [],
        metadata: intentMetadata[intent.displayName] || {
          purpose: 'No description',
          scope: 'unknown',
          keywords: []
        }
      }));
  } catch (error) {
    console.error('Error fetching intents:', error);
    return [];
  }
}

// MAIN: Groq Judge with STRICT Reusability Assessment
async function callGroqJudge(userMessage, dfResult, sessionId, allIntents, preCheck) {
  console.log('🔍 Groq analyzing...');
  
  const history = chatHistories.get(sessionId) || [];
  const historyContext = history.length > 0 
    ? history.map(h => `User: ${h.user}\nBot: ${h.bot}`).join('\n\n')
    : 'No previous conversation.';
  
  try {
    const apiKey = process.env.GROQ_API_KEY;
    const matchedIntent = allIntents.find(i => i.displayName === dfResult.intentName);
    
    const systemPrompt = `You are an intelligent chatbot with STRICT intent management.

## YOUR JOBS:
1. **ALWAYS answer the user helpfully** - this is your PRIMARY job
2. **STRICTLY evaluate** if this query should become a reusable intent
3. **Only save intents that OTHER USERS would also ask**

## DIALOGFLOW RESULT:
${matchedIntent ? `
Matched: ${matchedIntent.displayName}
Phrases: ${JSON.stringify(matchedIntent.trainingPhrases.slice(0, 5))}
` : 'No intent matched (fallback)'}

## EXISTING INTENTS:
${JSON.stringify(allIntents.map(i => ({
  name: i.displayName,
  phrases: i.trainingPhrases.slice(0, 3),
  purpose: i.metadata?.purpose || 'unknown'
})), null, 2)}

## CRITICAL: REUSABILITY PREDICTION

Before creating/updating ANY intent, ask yourself:
**"Would 100 different users independently ask this same question?"**

### NEVER SAVE (reusability_score 1-4):
- Personal requests: "my order", "my account", "call my mom"
- Time-specific: "weather today", "book tomorrow", "what happened yesterday"  
- Greetings: "hi", "hello", "how are you", "thanks" (already have defaults)
- Games/fun: "tell me a joke", "play a game", "flip a coin"
- Opinion questions: "what's the best...", "should I..."
- Current events: "latest news", "what happened today"
- Very short/vague: anything under 3 words
- Test messages: "test", "asdf", random characters
- Context-dependent: "yes", "no", "again", "tell me more"

### MAYBE SAVE (reusability_score 5-6):
- Somewhat general but could be one-time
- Needs more specific phrasing to be useful
- Similar intent might already exist

### DEFINITELY SAVE (reusability_score 7-10):
- **Factual questions**: "What is photosynthesis?", "How does gravity work?"
- **How-to guides**: "How to reset a router", "How to tie a tie"
- **Definitions**: "Define machine learning", "What does API mean?"
- **Comparisons**: "Difference between HTTP and HTTPS"
- **General knowledge**: "Capital of France", "Who invented the telephone"

## PRE-CHECK RESULT:
${JSON.stringify(preCheck)}
${preCheck.shouldSave === false ? '\n⚠️ PRE-CHECK SAYS: DO NOT SAVE THIS AS INTENT!' : ''}

## DECISION RULES:

1. If reusability_score < 7 → action: "none" (just answer, don't save)
2. If reusability_score >= 7 AND no similar intent exists → action: "create_new"
3. If reusability_score >= 7 AND similar intent exists with SAME purpose → action: "update_matched" or "update_other"
4. If DF matched WRONG intent → find correct one or create new (if reusability >= 7)

## RESPONSE FORMAT (JSON):
{
  "answer": "Your helpful response to the user",
  
  "reusability_analysis": {
    "score": number (1-10),
    "would_others_ask": boolean,
    "is_time_specific": boolean,
    "is_personal": boolean,
    "is_factual_knowledge": boolean,
    "reasoning": "why this score"
  },
  
  "match_analysis": {
    "dialogflow_intent": "matched intent name",
    "is_correct_match": boolean,
    "mismatch_reason": "if wrong"
  },
  
  "intent_action": {
    "action": "none" | "update_matched" | "update_other" | "create_new",
    "reasoning": "why this action",
    "target_intent": "for update_other",
    "new_intent_name": "for create_new (format: category_topic_scope)",
    "training_phrases": ["if saving"],
    "response_template": "if saving",
    "metadata": {
      "purpose": "what this intent handles",
      "scope": "specific scenarios",
      "keywords": ["key", "words"]
    }
  }
}

## REMEMBER:
- Your PRIMARY job is answering the user well
- Intent saving is SECONDARY and should be RARE
- When in doubt, action: "none"
- Only save things that are genuinely reusable knowledge`;

    const userPrompt = `## CONVERSATION HISTORY:
${historyContext}

## CURRENT USER MESSAGE:
"${userMessage}"

## DIALOGFLOW RESULT:
- Intent: ${dfResult.intentName}
- Confidence: ${dfResult.confidence}
- Response: "${dfResult.replyText}"

First, provide a helpful answer. Then, STRICTLY evaluate if this should be saved as an intent.
Remember: Most messages should NOT become intents!`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        model: 'llama-3.1-8b-instant',
        temperature: 0.3,
        max_tokens: 1200,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) throw new Error(`Groq API error: ${response.status}`);

    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content);
    
    // Log reusability analysis
    console.log('\n📊 REUSABILITY ANALYSIS:');
    if (parsed.reusability_analysis) {
      const ra = parsed.reusability_analysis;
      console.log(`   Score: ${ra.score}/10`);
      console.log(`   Would others ask: ${ra.would_others_ask ? '✅' : '❌'}`);
      console.log(`   Time-specific: ${ra.is_time_specific ? '⚠️ YES' : 'No'}`);
      console.log(`   Personal: ${ra.is_personal ? '⚠️ YES' : 'No'}`);
      console.log(`   Factual knowledge: ${ra.is_factual_knowledge ? '✅' : 'No'}`);
      console.log(`   Reasoning: ${ra.reasoning}`);
    }
    console.log(`   Action: ${parsed.intent_action?.action || 'none'}`);
    
    // ENFORCE: Override Groq if it tries to save low-reusability content
    if (parsed.reusability_analysis?.score < 7 && parsed.intent_action?.action !== 'none') {
      console.log('⚠️ OVERRIDE: Score < 7, forcing action to "none"');
      parsed.intent_action.action = 'none';
      parsed.intent_action.reasoning = 'Reusability score too low (< 7)';
    }
    
    // ENFORCE: Pre-check override
    if (preCheck.shouldSave === false && parsed.intent_action?.action !== 'none') {
      console.log('⚠️ OVERRIDE: Pre-check rejected, forcing action to "none"');
      parsed.intent_action.action = 'none';
      parsed.intent_action.reasoning = 'Pre-check rejected: ' + preCheck.reason;
    }
    
    return parsed;
  } catch (error) {
    console.error('❌ Groq error:', error);
    return {
      answer: "I'd be happy to help! Could you tell me more?",
      intent_action: { action: 'none' }
    };
  }
}

// Execute intent action
async function executeIntentAction(decision) {
  const action = decision.intent_action;
  if (!action || action.action === 'none') {
    return { success: true, action: 'none' };
  }
  
  // Final safety check
  const score = decision.reusability_analysis?.score || 0;
  if (score < 7) {
    console.log('🛑 BLOCKED: Reusability score too low');
    return { success: false, action: 'blocked_low_score' };
  }
  
  try {
    const projectAgentPath = intentsClient.projectAgentPath(projectId);
    
    if (action.action === 'update_matched' || action.action === 'update_other') {
      const targetName = action.action === 'update_other' 
        ? action.target_intent 
        : decision.match_analysis?.dialogflow_intent;
      
      if (!targetName) {
        console.log('⚠️ No target intent specified');
        return { success: false, action: 'no_target' };
      }
      
      const [intents] = await intentsClient.listIntents({ 
        parent: projectAgentPath,
        intentView: 'INTENT_VIEW_FULL'
      });
      
      const targetIntent = intents.find(i => i.displayName === targetName);
      if (!targetIntent) {
        console.log(`⚠️ Intent "${targetName}" not found, creating new instead`);
        action.action = 'create_new';
        action.new_intent_name = targetName;
      } else {
        const existingPhrases = targetIntent.trainingPhrases || [];
        const existingTexts = new Set(
          existingPhrases.map(tp => tp.parts.map(p => p.text).join('').toLowerCase())
        );
        
        const newPhrases = (action.training_phrases || [])
          .filter(p => !existingTexts.has(p.toLowerCase()))
          .map(p => ({ type: 'EXAMPLE', parts: [{ text: p }] }));
        
        if (newPhrases.length === 0) {
          console.log('ℹ️ No new phrases to add');
          return { success: true, action: 'no_changes' };
        }
        
        const updated = {
          name: targetIntent.name,
          displayName: targetIntent.displayName,
          trainingPhrases: [...existingPhrases, ...newPhrases],
          messages: targetIntent.messages,
          priority: targetIntent.priority,
          isFallback: targetIntent.isFallback,
          webhookState: targetIntent.webhookState,
          inputContextNames: targetIntent.inputContextNames,
          outputContexts: targetIntent.outputContexts,
          parameters: targetIntent.parameters
        };
        
        if (action.response_template) {
          const existingResponses = updated.messages?.[0]?.text?.text || [];
          if (!existingResponses.includes(action.response_template)) {
            if (updated.messages?.[0]?.text) {
              updated.messages[0].text.text.push(action.response_template);
            }
          }
        }
        
        await intentsClient.updateIntent({ intent: updated, languageCode: 'en' });
        
        if (action.metadata) {
          const existing = intentMetadata[targetName] || {};
          intentMetadata[targetName] = {
            ...existing,
            ...action.metadata,
            updated_at: new Date().toISOString()
          };
          saveIntentMetadata();
        }
        
        console.log(`✅ Updated intent: ${targetName} (+${newPhrases.length} phrases)`);
        return { success: true, action: 'updated', intent: targetName };
      }
    }
    
    if (action.action === 'create_new') {
      const intentName = action.new_intent_name;
      const phrases = action.training_phrases || [];
      const response = action.response_template || decision.answer;
      
      if (!intentName || phrases.length === 0) {
        console.log('⚠️ Missing data for new intent');
        return { success: false, action: 'invalid_data' };
      }
      
      const intent = {
        displayName: intentName,
        trainingPhrases: phrases.map(p => ({ 
          type: 'EXAMPLE', 
          parts: [{ text: p }] 
        })),
        messages: [{ text: { text: [response] } }]
      };
      
      await intentsClient.createIntent({ parent: projectAgentPath, intent });
      
      if (action.metadata) {
        intentMetadata[intentName] = {
          ...action.metadata,
          created_at: new Date().toISOString()
        };
        saveIntentMetadata();
      }
      
      console.log(`✅ Created new intent: ${intentName}`);
      return { success: true, action: 'created', intent: intentName };
    }
    
    return { success: false, action: 'unknown' };
  } catch (error) {
    console.error('❌ Intent action error:', error);
    return { success: false, action: 'error', error: error.message };
  }
}

// Check Dialogflow connection
async function checkDialogflowConnection() {
  try {
    const sessionId = 'test-' + Math.random().toString(36).substring(7);
    const sessionPath = sessionClient.projectAgentSessionPath(projectId, sessionId);
    await sessionClient.detectIntent({
      session: sessionPath,
      queryInput: { text: { text: 'test', languageCode: 'en-US' } }
    });
    return { status: 'connected' };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

// Main message handler
async function handleMessage(sessionId, message) {
  console.log('\n' + '='.repeat(60));
  console.log('📨 Message:', message);
  console.log('='.repeat(60));
  
  // Step 1: Check if context-dependent
  if (isContextDependent(message)) {
    console.log('🧠 Context-dependent - answering only, no intent save');
    
    const decision = await callGroqJudge(message, {
      intentName: 'context-dependent',
      confidence: 0,
      replyText: ''
    }, sessionId, [], { shouldSave: false, reason: 'Context-dependent', score: 1 });
    
    if (!chatHistories.has(sessionId)) chatHistories.set(sessionId, []);
    const h = chatHistories.get(sessionId);
    h.push({ user: message, bot: decision.answer });
    if (h.length > MAX_HISTORY_LENGTH) h.shift();
    
    return {
      text: decision.answer,
      intent: 'context-dependent',
      confidence: 1,
      actionTaken: 'none'
    };
  }
  
  // Step 2: Pre-check reusability
  const preCheck = preCheckReusability(message);
  console.log(`📋 Pre-check: ${preCheck.reason} (score: ${preCheck.score})`);
  
  try {
    // Step 3: Get Dialogflow's response
    const sessionPath = sessionClient.projectAgentSessionPath(projectId, sessionId);
    const [response] = await sessionClient.detectIntent({
      session: sessionPath,
      queryInput: { text: { text: message, languageCode: 'en-US' } }
    });
    
    const result = response.queryResult;
    const dfResult = {
      intentName: result.intent.displayName,
      confidence: result.intentDetectionConfidence,
      replyText: result.fulfillmentText
    };
    
    console.log(`🤖 Dialogflow: ${dfResult.intentName} (${dfResult.confidence.toFixed(2)})`);
    
    // Step 4: Get all intents (only if preCheck allows saving)
    let allIntents = [];
    if (preCheck.shouldSave !== false) {
      allIntents = await getAllIntentsWithDetails();
      console.log(`📚 Loaded ${allIntents.length} intents`);
    }
    
    // Step 5: Groq analyzes with pre-check info
    const decision = await callGroqJudge(message, dfResult, sessionId, allIntents, preCheck);
    
    // Step 6: Execute action only if allowed
    let actionResult = { action: 'none' };
    if (decision.intent_action?.action !== 'none' && preCheck.shouldSave !== false) {
      actionResult = await executeIntentAction(decision);
      console.log(`🔧 Result: ${actionResult.action}`);
    } else if (preCheck.shouldSave === false) {
      console.log('🚫 Intent save blocked by pre-check');
    }
    
    // Step 7: Update chat history
    if (!chatHistories.has(sessionId)) chatHistories.set(sessionId, []);
    const history = chatHistories.get(sessionId);
    history.push({ user: message, bot: decision.answer });
    if (history.length > MAX_HISTORY_LENGTH) history.shift();
    
    // Log decision
    decisionLogs.push({
      timestamp: new Date().toISOString(),
      message,
      dfIntent: dfResult.intentName,
      dfConfidence: dfResult.confidence,
      reusabilityScore: decision.reusability_analysis?.score,
      action: actionResult.action,
      blocked: preCheck.shouldSave === false
    });
    if (decisionLogs.length > 100) decisionLogs.shift();
    
    console.log(`📤 Response: "${decision.answer?.substring(0, 80)}..."`);
    console.log('='.repeat(60) + '\n');
    
    return {
      text: decision.answer,
      intent: dfResult.intentName,
      confidence: dfResult.confidence,
      reusabilityScore: decision.reusability_analysis?.score,
      actionTaken: actionResult.action
    };
    
  } catch (error) {
    console.error('❌ Error:', error);
    return {
      text: 'Sorry, I encountered an error. Please try again.',
      intent: 'error',
      confidence: 0
    };
  }
}

// API Routes
app.get('/api/logs', (req, res) => {
  res.json({ total: decisionLogs.length, logs: decisionLogs.slice(-30) });
});

app.get('/api/intents', async (req, res) => {
  const intents = await getAllIntentsWithDetails();
  res.json({ count: intents.length, intents });
});

app.get('/api/metadata', (req, res) => {
  res.json(intentMetadata);
});

app.post('/api/metadata/:name', (req, res) => {
  const { name } = req.params;
  intentMetadata[name] = { ...(intentMetadata[name] || {}), ...req.body, updated_at: new Date().toISOString() };
  saveIntentMetadata();
  res.json({ success: true, metadata: intentMetadata[name] });
});

// Socket.io
io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);
  sessions.set(socket.id, { id: socket.id });
  
  checkDialogflowConnection().then(s => socket.emit('connection-status', s));

  socket.on('send-message', async (msg) => {
    const response = await handleMessage(socket.id, msg);
    socket.emit('receive-message', {
      text: response.text,
      sender: 'bot',
      timestamp: new Date().toISOString(),
      metadata: {
        intent: response.intent,
        confidence: response.confidence,
        reusabilityScore: response.reusabilityScore,
        actionTaken: response.actionTaken
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('🔌 Disconnected:', socket.id);
    sessions.delete(socket.id);
    chatHistories.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 Server: http://localhost:${PORT}`);
  console.log(`📊 Logs: http://localhost:${PORT}/api/logs`);
  console.log(`🎯 Intents: http://localhost:${PORT}/api/intents`);
  console.log('='.repeat(60) + '\n');
  
  checkDialogflowConnection().then(s => console.log(`🤖 Dialogflow: ${s.status}`));
});

module.exports = { server };