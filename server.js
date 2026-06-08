/**
 * AIBO — AI不動産管理システム
 * LINE Webhook サーバー (Google Cloud Run 対応)
 */

require('dotenv').config();

const express  = require('express');
const crypto   = require('crypto');
const axios    = require('axios');
const admin    = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 8080;

const LINE_CHANNEL_SECRET       = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY            = process.env.OPENAI_API_KEY;

if (process.env.FIREBASE_SERVICE_ACCOUNT) { const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); } else { admin.initializeApp({ credential: admin.credential.applicationDefault() }); }
const db = admin.firestore();

// Stripe Webhook
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  res.status(200).json({ received: true });
  switch (event.type) {
    case 'checkout.session.completed':
    case 'invoice.payment_succeeded': {
      const obj = event.data.object;
      const lineUserId = obj.metadata?.lineUserId || obj.client_reference_id;
      if (lineUserId) await handleProActivated(lineUserId, obj.subscription || obj.id);
      break;
    }
    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      const obj = event.data.object;
      const lineUserId = obj.metadata?.lineUserId;
      if (lineUserId) await handleProCancelled(lineUserId);
      break;
    }
  }
});

app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.get('/', (_req, res) => res.send('AIBO Webhook Server OK'));

app.post('/webhook', async (req, res) => {
  if (!verifyLineSignature(req)) {
    console.warn('署名検証失敗');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.status(200).end();
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
});

function verifyLineSignature(req) {
  const signature = req.headers['x-line-signature'];
  if (!signature) return false;
  const hash = crypto.createHmac('SHA256', LINE_CHANNEL_SECRET).update(req.rawBody).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
}

async function handleEvent(event) {
  const { type, source } = event;
  const userId = source?.userId;
  console.log(`[Event] type=${type} userId=${userId}`);
  switch (type) {
    case 'follow':   await handleFollow(userId); break;
    case 'message':  await handleMessage(event, userId); break;
    case 'postback': await handlePostback(event, userId); break;
    default: console.log(`未対応イベント: ${type}`);
  }
}

async function handleFollow(userId) {
  await db.collection('users').doc(userId).set({
    lineUserId: userId,
    registeredAt: admin.firestore.FieldValue.serverTimestamp(),
    plan: 'free', status: 'pending',
  }, { merge: true });
  const registerUrl = `https://aibo-system.web.app/register?lid=${userId}`;
  await lineReply(userId, [{ type: 'flex', altText: 'AIBOへようこそ！', contents: buildWelcomeCard(registerUrl) }]);
}

async function handleMessage(event, userId) {
  const { message } = event;
  const userDoc = await db.collection('users').doc(userId).get();
  const user  = userDoc.exists ? userDoc.data() : {};
  const state = user.state || 'default';

  if (message.type === 'text') {
    const text = message.text.trim();
    if (text === '物件登録' || text === '1') return await startPropertyRegistration(userId);
    if (text === '希望案件' || text === '2') return await startRequestRegistration(userId);
    if (text === '報酬確認' || text === '3') return await sendRewardSummary(userId);
    if (text === '商流確認' || text === '4') return await sendFlowInfo(userId);
    if (text === 'PRO' || text === 'pro' || text === 'アップグレード') return await sendProUpgradeLink(userId);
    if (state === 'awaiting_property_text') return await parsePropertyText(userId, text);
    if (state === 'awaiting_request_text')  return await savePropertyRequest(userId, text);
    if (/^[A-Z0-9]{6}$/.test(text)) return await handleFlowCode(userId, text);
    return await handleFreeText(userId, text);
  }
  if (message.type === 'image') return await handlePropertyImage(userId, message.id);
  if (message.type === 'audio') return await handleAudioMessage(userId, message.id);
  if (message.type === 'file')  return await handlePropertyFile(userId, message.id, message.fileName);
}

async function handlePropertyImage(userId, messageId) {
  await lineReply(userId, [{ type: 'text', text: '📷 画像を解析中です…' }]);
  try {
    const imageRes = await axios.get(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }, responseType: 'arraybuffer' }
    );
    const base64Image = Buffer.from(imageRes.data).toString('base64');
    const mimeType = imageRes.headers['content-type'] || 'image/jpeg';
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o', response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildPropertyExtractionPrompt() },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          { type: 'text', text: 'この画像から物件情報を抽出してください。' }
        ]}
      ]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    const parsed = JSON.parse(response.data.choices[0].message.content);
    const ref = await db.collection('properties').add({
      ...parsed, submittedBy: userId, inputType: 'image',
      createdAt: admin.firestore.FieldValue.serverTimestamp(), status: 'draft',
    });
    await db.collection('users').doc(userId).set({ state: 'default' }, { merge: true });
    await startFlowVerification(userId, ref.id, parsed.propertyName || '無題物件');
    await lineReply(userId, [{ type: 'flex', altText: '物件登録完了', contents: buildPropertyConfirmCard(parsed, ref.id) }]);
  } catch (err) {
    console.error('画像解析エラー:', err.response?.data || err.message);
    await lineReply(userId, [{ type: 'text', text: '画像の解析に失敗しました。テキストで送ってください。' }]);
  }
}

async function handleAudioMessage(userId, messageId) {
  await lineReply(userId, [{ type: 'text', text: '🎙️ 音声を認識中です…' }]);
  try {
    const audioRes = await axios.get(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }, responseType: 'arraybuffer' }
    );
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', Buffer.from(audioRes.data), { filename: 'audio.m4a', contentType: 'audio/m4a' });
    form.append('model', 'whisper-1');
    form.append('language', 'ja');
    const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    const transcript = whisperRes.data.text;
    if (!transcript || transcript.trim().length < 5) {
      return await lineReply(userId, [{ type: 'text', text: '音声が聞き取れませんでした。' }]);
    }
    await lineReply(userId, [{ type: 'text', text: `📝 認識結果:\n"${transcript}"\n\n解析します…` }]);
    await parsePropertyText(userId, transcript);
  } catch (err) {
    console.error('音声解析エラー:', err.response?.data || err.message);
    await lineReply(userId, [{ type: 'text', text: '音声の処理に失敗しました。テキストでお送りください。' }]);
  }
}

async function handlePropertyFile(userId, messageId, fileName) {
  await lineReply(userId, [{ type: 'text', text: `📄 「${fileName}」を受け取りました。\nテキストで物件情報を貼り付けていただけますか？` }]);
  await db.collection('users').doc(userId).set({ state: 'awaiting_property_text' }, { merge: true });
}

async function handleFlowCode(userId, code) {
  try {
    const snapshot = await db.collection('flowVerifications').where(`codes.${code}.forUserId`, '!=', null).limit(1).get();
    if (snapshot.empty) return await handleFreeText(userId, code);
    const flowDoc = snapshot.docs[0];
    const flow = flowDoc.data();
    const propertyId = flowDoc.id;
    const codeData = flow.codes[code];
    if (flow.chain.some(c => c.userId === userId)) {
      return await lineReply(userId, [{ type: 'text', text: 'このコードはすでに使用済みです。' }]);
    }
    await flowDoc.ref.update({
      chain: [...flow.chain, { userId, role: 'unknown', verifiedAt: null }],
      [`codes.${code}.usedAt`]: new Date(),
      [`codes.${code}.usedBy`]: userId,
    });
    await lineReply(userId, [{ type: 'flex', altText: '商流コード認証完了', contents: buildRoleSelectCard(propertyId, flow.propertyName) }]);
    if (codeData?.forUserId) {
      await lineReply(codeData.forUserId, [{ type: 'text', text: `✅ 商流コードが使用されました。\n「${flow.propertyName}」の商流が1段階つながりました。` }]);
    }
  } catch (err) {
    console.error('商流コード処理エラー:', err);
    await handleFreeText(userId, code);
  }
}

async function requestPropertyDocs(userId, propertyId) {
  const propDoc = await db.collection('properties').doc(propertyId).get();
  if (!propDoc.exists) return await lineReply(userId, [{ type: 'text', text: '物件情報が見つかりませんでした。' }]);
  const prop = propDoc.data();
  await db.collection('docRequests').add({
    requestedBy: userId, propertyId, propertyName: prop.propertyName || '',
    requestedAt: admin.firestore.FieldValue.serverTimestamp(), status: 'pending',
    docs: ['登記簿謄本', '公図', '測量図', '建物図面', '固定資産税評価証明'],
  });
  const flowDoc = await db.collection('flowVerifications').doc(propertyId).get();
  if (flowDoc.exists) {
    const chain = flowDoc.data().chain || [];
    const notifyId = (chain.find(c => c.role === 'seller') || chain.find(c => c.role === 'agent'))?.userId;
    if (notifyId && notifyId !== userId) {
      await lineReply(notifyId, [{ type: 'flex', altText: '書類提出のご依頼', contents: buildDocRequestCard(prop.propertyName, propertyId) }]);
    }
  }
  await lineReply(userId, [{ type: 'text', text: `📋 「${prop.propertyName}」の書類を請求しました。` }]);
}

async function parsePropertyText(userId, text) {
  await lineReply(userId, [{ type: 'text', text: '📋 物件情報を解析中です…' }]);
  try {
    const parsed = await extractPropertyDataWithAI(text);
    const ref = await db.collection('properties').add({
      ...parsed, submittedBy: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), status: 'draft',
    });
    await db.collection('users').doc(userId).set({ state: 'default' }, { merge: true });
    await startFlowVerification(userId, ref.id, parsed.propertyName);
    await lineReply(userId, [{ type: 'flex', altText: '物件登録完了', contents: buildPropertyConfirmCard(parsed, ref.id) }]);
  } catch (err) {
    console.error('AI解析エラー:', err);
    await lineReply(userId, [{ type: 'text', text: '解析に失敗しました。もう一度お送りください。' }]);
  }
}

async function extractPropertyDataWithAI(text) {
  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o', response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildPropertyExtractionPrompt() },
      { role: 'user', content: text }
    ]
  }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
  return JSON.parse(response.data.choices[0].message.content);
}

function buildPropertyExtractionPrompt() {
  return `あなたは不動産の専門家です。送られたテキストまたは画像から物件情報を抽出し、以下のJSON形式で返してください。値が不明な場合はnullを使用してください。
{"propertyName":"物件名","propertyType":"種別","address":"所在地","price":価格,"area":面積,"buildYear":築年,"structure":"構造","floors":階数,"landArea":土地面積,"currentUse":"現況","zoning":"用途地域","coverage":建蔽率,"floorRatio":容積率,"yieldRate":利回り,"monthlyRent":月額賃料,"remarks":"備考","merits":["メリット"],"demerits":["デメリット"],"risks":["リスク"]}`;
}

async function startFlowVerification(fromUserId, propertyId, propertyName) {
  const flowCode = generateFlowCode();
  await db.collection('flowVerifications').doc(propertyId).set({
    propertyId, propertyName,
    chain: [{ userId: fromUserId, role: 'unknown', verifiedAt: null }],
    flowCode, codes: {}, status: 'in_progress',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await lineReply(fromUserId, [{ type: 'flex', altText: '商流確認のお願い', contents: buildFlowVerificationCard(propertyName, flowCode, propertyId) }]);
}

async function handlePostback(event, userId) {
  const data = new URLSearchParams(event.postback.data);
  const action = data.get('action');
  switch (action) {
    case 'register_property': await startPropertyRegistration(userId); break;
    case 'set_role': await setUserRole(userId, data.get('pid'), data.get('role')); break;
    case 'request_docs': await requestPropertyDocs(userId, data.get('pid')); break;
    case 'deal_closed': await handleDealClosed(userId, data.get('pid')); break;
    case 'upgrade_pro': await sendProUpgradeLink(userId); break;
  }
}

async function confirmFlowStep(userId, propertyId, role) {
  const flowRef = db.collection('flowVerifications').doc(propertyId);
  const flowDoc = await flowRef.get();
  if (!flowDoc.exists) return;
  const flow = flowDoc.data();
  await flowRef.update({ chain: [...flow.chain, { userId, role, verifiedAt: admin.firestore.FieldValue.serverTimestamp() }] });
  await lineReply(userId, [{ type: 'flex', altText: 'あなたの立場を教えてください', contents: buildRoleSelectCard(propertyId, flow.propertyName) }]);
}

async function setUserRole(userId, propertyId, role) {
  const flowRef = db.collection('flowVerifications').doc(propertyId);
  const flowDoc = await flowRef.get();
  if (!flowDoc.exists) return;
  const flow  = flowDoc.data();
  const chain = flow.chain.map(c => c.userId === userId ? { ...c, role } : c);
  await flowRef.update({ chain });
  if (role === 'seller') {
    await lineReply(userId, [{ type: 'flex', altText: '本人確認書類の提出をお願いします', contents: buildIdVerificationCard(propertyId, flow.propertyName) }]);
    await flowRef.update({ status: 'reached_seller' });
    await notifyAdmin(`【商流到達】${flow.propertyName} の売主(${userId})に到達しました。`);
  } else {
    const flowCode = generateFlowCode();
    await flowRef.update({ [`codes.${flowCode}`]: { forUserId: userId, createdAt: new Date() } });
    await lineReply(userId, [{ type: 'text', text: `ありがとうございます。\nあなたに情報をくれた方に以下のコードを共有してください。\n\n🔑 商流コード: ${flowCode}` }]);
  }
}

async function sendRewardSummary(userId) {
  const [rewardSnap, propSnap, userDoc] = await Promise.all([
    db.collection('rewards').where('userId', '==', userId).limit(10).get(),
    db.collection('properties').where('submittedBy', '==', userId).limit(5).get(),
    db.collection('users').doc(userId).get(),
  ]);
  const user   = userDoc.exists ? userDoc.data() : {};
  const isPro  = user.plan === 'pro';
  const totalPaid    = rewardSnap.docs.filter(d => d.data().status === 'paid').reduce((s, d) => s + (d.data().amount || 0), 0);
  const totalPending = rewardSnap.docs.filter(d => d.data().status === 'confirmed').reduce((s, d) => s + (d.data().amount || 0), 0);
  const lines = [`【あなたの報酬状況】`, `プラン: ${isPro ? '⭐ PRO' : 'FREE'}\n`];
  if (totalPaid > 0 || totalPending > 0) {
    lines.push(`💰 支払済み: ¥${totalPaid.toLocaleString()}`);
    lines.push(`⏳ 確定待ち: ¥${totalPending.toLocaleString()}\n`);
  }
  if (!propSnap.empty) {
    const baseRate = isPro ? 0.006 : 0.005;
    const statusMap = { draft:'下書き', active:'公開中', negotiating:'交渉中', contracted:'契約済', closed:'成約' };
    lines.push('【登録物件の想定報酬】');
    propSnap.docs.forEach(d => {
      const p = d.data();
      const est = p.price ? Math.round(p.price * baseRate) : null;
      lines.push(`📍 ${p.propertyName || '未設定'}\n   ${statusMap[p.status] || p.status}  想定: ${est ? `¥${est.toLocaleString()}` : '未確定'}`);
    });
  }
  if (lines.length === 2) lines.push('関連する物件がまだありません。');
  if (!isPro) lines.push(`\n⭐ PROにアップグレードで報酬+0.1%\nhttps://aibo-system.web.app/upgrade`);
  await lineReply(userId, [{ type: 'text', text: lines.join('\n') }]);
}

async function calculateAndDistributeRewards(propertyId) {
  const propDoc = await db.collection('properties').doc(propertyId).get();
  if (!propDoc.exists) throw new Error('物件が見つかりません');
  const prop = propDoc.data();
  if (!prop.price) throw new Error('価格が未設定です');
  const flowDoc = await db.collection('flowVerifications').doc(propertyId).get();
  const chain   = flowDoc.exists ? (flowDoc.data().chain || []) : [];
  if (chain.length === 0) throw new Error('商流チェーンが空です');
  const userDocs = await Promise.all(chain.map(c => db.collection('users').doc(c.userId).get()));
  const userPlans = {};
  userDocs.forEach(d => { if (d.exists) userPlans[d.id] = d.data().plan || 'free'; });
  const basePool  = Math.round(prop.price * 0.005);
  const shareEach = Math.round(basePool / chain.length);
  const proBonus  = Math.round(prop.price * 0.001);
  const batch = db.batch();
  for (const node of chain) {
    const isPro  = userPlans[node.userId] === 'pro';
    const amount = shareEach + (isPro ? proBonus : 0);
    const ref    = db.collection('rewards').doc();
    batch.set(ref, {
      userId: node.userId, propertyId, propertyName: prop.propertyName || '',
      role: node.role, chainIndex: chain.indexOf(node), chainTotal: chain.length,
      baseAmount: shareEach, bonusAmount: isPro ? proBonus : 0, amount,
      percentage: Number((amount / prop.price * 100).toFixed(4)),
      status: 'confirmed', createdAt: admin.firestore.FieldValue.serverTimestamp(), paidAt: null,
    });
  }
  batch.update(db.collection('properties').doc(propertyId), { status: 'closed', closedAt: admin.firestore.FieldValue.serverTimestamp() });
  await batch.commit();
  for (const node of chain) {
    const isPro  = userPlans[node.userId] === 'pro';
    const amount = shareEach + (isPro ? proBonus : 0);
    await lineReply(node.userId, [{ type: 'flex', altText: '🎉 報酬が確定しました！', contents: buildRewardConfirmCard(prop.propertyName, amount, isPro) }]);
  }
  await notifyAdmin(`【成約】${prop.propertyName}\n価格: ¥${prop.price.toLocaleString()}\n分配: ${chain.length}名 × ¥${shareEach.toLocaleString()}`);
  return { basePool, shareEach, chain: chain.length };
}

async function handleDealClosed(userId, propertyId) {
  const propDoc = await db.collection('properties').doc(propertyId).get();
  if (!propDoc.exists) return;
  const prop = propDoc.data();
  if (prop.submittedBy !== userId && process.env.ADMIN_LINE_USER_ID !== userId) {
    return await lineReply(userId, [{ type: 'text', text: '成約処理は物件登録者のみ実行できます。' }]);
  }
  if (prop.status === 'closed') return await lineReply(userId, [{ type: 'text', text: 'この物件はすでに成約済みです。' }]);
  await lineReply(userId, [{ type: 'text', text: '🎉 成約処理を開始します…' }]);
  try {
    const result = await calculateAndDistributeRewards(propertyId);
    await lineReply(userId, [{ type: 'text', text: `✅ 報酬分配完了！\n物件: ${prop.propertyName}\n分配人数: ${result.chain}名\n1人あたり: ¥${result.shareEach.toLocaleString()}` }]);
  } catch (err) {
    await lineReply(userId, [{ type: 'text', text: `成約処理に失敗しました: ${err.message}` }]);
  }
}

async function handleFreeText(userId, text) {
  await lineReply(userId, [{ type: 'flex', altText: 'AIBOメニュー', contents: buildMainMenu() }]);
}

async function sendProUpgradeLink(userId) {
  const upgradeUrl = `https://aibo-system.web.app/upgrade?lid=${userId}`;
  await lineReply(userId, [{ type: 'flex', altText: '⭐ PROプランのご案内', contents: buildProUpgradeCard(upgradeUrl) }]);
}

async function handleProActivated(lineUserId, subscriptionId) {
  await db.collection('users').doc(lineUserId).set({ plan: 'pro', subscriptionId, proStartedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await lineReply(lineUserId, [{ type: 'text', text: '⭐ PROアップグレード完了！\n\n・報酬率 +0.1% アップ\n・物件が優先掲載\n・商流図エクスポートが使えます' }]);
  await notifyAdmin(`【PRO登録】${lineUserId} がPROにアップグレードしました。`);
}

async function handleProCancelled(lineUserId) {
  await db.collection('users').doc(lineUserId).set({ plan: 'free', subscriptionId: null, proCancelledAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await lineReply(lineUserId, [{ type: 'text', text: 'PROプランが解約されました。引き続きFREEプランでご利用いただけます。' }]);
}

function generateFlowCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function startPropertyRegistration(userId) {
  await db.collection('users').doc(userId).set({ state: 'awaiting_property_text' }, { merge: true });
  await lineReply(userId, [{ type: 'text', text: '📝 物件情報を送ってください。\n\n概要書のテキストをそのまま貼り付けるか、以下の項目を入力してください。\n\n・物件名\n・所在地\n・価格\n・面積\n・種別\n・築年\n・利回り（あれば）\n・その他特記事項' }]);
}

async function startRequestRegistration(userId) {
  await db.collection('users').doc(userId).set({ state: 'awaiting_request_text' }, { merge: true });
  await lineReply(userId, [{ type: 'text', text: '🔍 探している物件の条件を教えてください（エリア・予算・種別・用途など）' }]);
}

async function savePropertyRequest(userId, text) {
  await db.collection('requests').add({ userId, text, createdAt: admin.firestore.FieldValue.serverTimestamp(), status: 'open' });
  await db.collection('users').doc(userId).set({ state: 'default' }, { merge: true });
  await lineReply(userId, [{ type: 'text', text: '✅ リクエストを受け付けました！\n登録者全員にお知らせします。マッチした物件が見つかり次第ご連絡します。' }]);
}

async function sendFlowInfo(userId) {
  const snapshot = await db.collection('flowVerifications').where('chain', 'array-contains', { userId, role: 'unknown', verifiedAt: null }).limit(3).get();
  await lineReply(userId, [{ type: 'text', text: snapshot.empty ? '現在確認中の商流はありません。' : `${snapshot.size}件の商流確認が進行中です。\nhttps://aibo-system.web.app/flow` }]);
}

async function lineReply(to, messages) {
  await axios.post('https://api.line.me/v2/bot/message/push', { to, messages },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
  ).catch(e => console.error('LINE送信エラー:', e.response?.data || e.message));
}

async function notifyAdmin(message) {
  const ADMIN_USER_ID = process.env.ADMIN_LINE_USER_ID;
  if (ADMIN_USER_ID) await lineReply(ADMIN_USER_ID, [{ type: 'text', text: message }]);
}

// Flex Message テンプレート
function buildWelcomeCard(registerUrl) {
  return {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#0a0c10', contents: [{ type: 'text', text: 'AIBO', size: '3xl', weight: 'bold', color: '#00e5a0', align: 'center' }] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: 'AI不動産管理システムへようこそ！', weight: 'bold', size: 'md', wrap: true },
      { type: 'text', text: 'まずは無料登録をして、物件情報の登録・閲覧・報酬受取を始めましょう。', size: 'sm', color: '#7a8599', wrap: true },
      { type: 'separator' },
      { type: 'text', text: '✅ 無料でできること', weight: 'bold', size: 'sm' },
      { type: 'text', text: '・物件情報の登録・閲覧\n・希望案件リクエスト\n・紹介報酬の受取（0.5%を分配）', size: 'sm', color: '#7a8599', wrap: true },
      { type: 'text', text: '⭐ PRO会員（¥3,300/月）', weight: 'bold', size: 'sm', color: '#f0b429' },
      { type: 'text', text: '・報酬+0.1%\n・優先掲載\n・商流図エクスポート', size: 'sm', color: '#7a8599', wrap: true },
    ]},
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', color: '#00e5a0', action: { type: 'uri', label: '📝 無料登録はこちら', uri: registerUrl } },
      { type: 'button', style: 'secondary', action: { type: 'message', label: 'メニューを見る', text: 'メニュー' } }
    ]}
  };
}

function buildMainMenu() {
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: 'AIBOメニュー', weight: 'bold', size: 'lg' },
      { type: 'separator' },
      ...[['1','🏢 物件登録','概要書・テキストから登録'],['2','🔍 希望案件','探している物件を登録'],['3','💰 報酬確認','自分の報酬・進捗を確認'],['4','🔗 商流確認','紹介ルートの状況を確認']].map(([num,label,desc]) => ({
        type: 'box', layout: 'horizontal', paddingAll: 'sm',
        action: { type: 'message', label, text: num },
        contents: [{ type: 'text', text: label, flex: 3, size: 'sm', weight: 'bold' }, { type: 'text', text: desc, flex: 5, size: 'xs', color: '#7a8599' }]
      }))
    ]}
  };
}

function buildPropertyConfirmCard(data, propertyId) {
  return {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#0a1a14', contents: [{ type: 'text', text: '✅ 物件登録完了', weight: 'bold', color: '#00e5a0' }] },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: data.propertyName || '物件名未設定', weight: 'bold', size: 'lg', wrap: true },
      { type: 'text', text: data.address || '-', size: 'sm', color: '#7a8599', wrap: true },
      { type: 'separator' },
      row('価格', data.price ? `¥${Number(data.price).toLocaleString()}` : '-'),
      row('面積', data.area ? `${data.area}㎡` : '-'),
      row('種別', data.propertyType || '-'),
      row('利回り', data.yieldRate ? `${data.yieldRate}%` : '-'),
      ...(data.merits?.length ? [{ type: 'text', text: '📈 メリット', weight: 'bold', size: 'sm', margin: 'md' }, ...data.merits.map(m => ({ type: 'text', text: `・${m}`, size: 'sm', color: '#00e5a0', wrap: true }))] : []),
      ...(data.risks?.length ? [{ type: 'text', text: '⚠️ リスク', weight: 'bold', size: 'sm', margin: 'md', color: '#ff6b35' }, ...data.risks.map(r => ({ type: 'text', text: `・${r}`, size: 'sm', color: '#ff6b35', wrap: true }))] : []),
    ]},
    footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', color: '#0077ff', action: { type: 'uri', label: '📊 Webで詳細を見る', uri: `https://aibo-system.web.app/properties/${propertyId}` } }] }
  };
}

function buildFlowVerificationCard(propertyName, flowCode, propertyId) {
  return {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#0a0f1a', contents: [{ type: 'text', text: '🔗 商流確認のお願い', weight: 'bold', color: '#0077ff' }] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: `「${propertyName}」の情報をお持ちいただきありがとうございます。`, size: 'sm', wrap: true },
      { type: 'text', text: 'スムーズな取引のため、情報をくれた方を確認させてください。', size: 'sm', color: '#7a8599', wrap: true },
      { type: 'separator' },
      { type: 'text', text: `🔑 商流コード: ${flowCode}`, weight: 'bold', size: 'md', color: '#f0b429' },
      { type: 'text', text: 'このコードをあなたに情報をくれた方に共有してください。', size: 'xs', color: '#7a8599', wrap: true },
    ]},
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', color: '#0077ff', action: { type: 'postback', label: '✅ 私が売主（当事者）です', data: `action=set_role&pid=${propertyId}&role=seller` } },
      { type: 'button', style: 'secondary', action: { type: 'postback', label: '私は仲介・紹介者です', data: `action=set_role&pid=${propertyId}&role=broker` } }
    ]}
  };
}

function buildRoleSelectCard(propertyId, propertyName) {
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: `「${propertyName}」について`, size: 'sm', color: '#7a8599', wrap: true },
      { type: 'text', text: 'あなたの立場を教えてください', weight: 'bold', size: 'lg', wrap: true },
    ]},
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', color: '#00e5a0', action: { type: 'postback', label: '🏠 売主（所有者）', data: `action=set_role&pid=${propertyId}&role=seller` } },
      { type: 'button', style: 'secondary', action: { type: 'postback', label: '📋 元付け（媒介契約あり）', data: `action=set_role&pid=${propertyId}&role=agent` } },
      { type: 'button', style: 'secondary', action: { type: 'postback', label: '🤝 仲介・紹介者', data: `action=set_role&pid=${propertyId}&role=broker` } },
    ]}
  };
}

function buildIdVerificationCard(propertyId, propertyName) {
  return {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#1a0a0a', contents: [{ type: 'text', text: '🏠 売主様へ', weight: 'bold', color: '#ff6b35' }] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: `「${propertyName}」の売主様として確認が取れました。`, size: 'sm', wrap: true },
      { type: 'text', text: '本人確認のため、運転免許証またはマイナンバーカード（表面）の写真をこのLINEに送信してください。', size: 'sm', wrap: true },
      { type: 'separator' },
      { type: 'text', text: '確認後、AIBOから直接ご挨拶のメッセージをお送りします。', size: 'xs', color: '#7a8599', wrap: true },
    ]}
  };
}

function buildRewardConfirmCard(propertyName, amount, isPro) {
  return {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#0a1a0a', contents: [{ type: 'text', text: '🎉 報酬確定！', weight: 'bold', color: '#00e5a0', size: 'xl' }] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: propertyName || '物件', size: 'sm', color: '#7a8599', wrap: true },
      { type: 'separator' },
      { type: 'text', text: `¥${amount.toLocaleString()}`, weight: 'bold', size: '3xl', color: '#00e5a0', align: 'center' },
      { type: 'text', text: isPro ? '⭐ PROボーナス込み' : 'FREE報酬', size: 'xs', color: '#7a8599', align: 'center' },
      { type: 'separator' },
      { type: 'text', text: '銀行振込にて1週間以内にお支払いします。', size: 'xs', color: '#7a8599', wrap: true },
    ]},
    footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', color: '#00e5a0', action: { type: 'message', label: '💰 報酬状況を確認', text: '報酬確認' } }] }
  };
}

function buildProUpgradeCard(upgradeUrl) {
  return {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#1a1200', contents: [{ type: 'text', text: '⭐ PRO会員のご案内', weight: 'bold', color: '#f0b429', size: 'lg' }] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: '月額 ¥3,300（税込）', weight: 'bold', size: 'xl', color: '#f0b429' },
      { type: 'separator' },
      { type: 'text', text: '✅ PRO特典', weight: 'bold', size: 'sm' },
      { type: 'text', text: '・報酬率 +0.1%\n・物件の優先掲載\n・商流図エクスポート\n・優先サポート', size: 'sm', color: '#7a8599', wrap: true },
      { type: 'separator' },
      { type: 'text', text: '例: 1億円物件\nFREE ¥50,000 → PRO ¥60,000', size: 'sm', color: '#00e5a0', wrap: true },
    ]},
    footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', color: '#f0b429', action: { type: 'uri', label: '⭐ PROにアップグレード', uri: upgradeUrl } }] }
  };
}

function buildDocRequestCard(propertyName, propertyId) {
  return {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#0a0f1a', contents: [{ type: 'text', text: '📋 書類提出のご依頼', weight: 'bold', color: '#0077ff' }] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: `「${propertyName}」について書類の請求がありました。`, size: 'sm', wrap: true },
      { type: 'separator' },
      { type: 'text', text: '・登記簿謄本\n・公図\n・測量図\n・建物図面（あれば）\n・固定資産税評価証明', size: 'sm', color: '#7a8599', wrap: true },
    ]},
    footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', color: '#0077ff', action: { type: 'uri', label: '📤 Webからアップロード', uri: `https://aibo-system.web.app/docs/upload?pid=${propertyId}` } }] }
  };
}

function row(label, value) {
  return { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: label, size: 'sm', color: '#7a8599', flex: 3 }, { type: 'text', text: value, size: 'sm', weight: 'bold', flex: 5, align: 'end' }] };
}

app.listen(PORT, () => {
  console.log(`AIBO Webhook Server listening on port ${PORT}`);
});
