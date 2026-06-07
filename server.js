/**
 * AIBO — AI不動産管理システム
 * LINE Webhook サーバー (Google Cloud Run 対応)
 *
 * 起動: node server.js
 * 環境変数は .env または Cloud Run のシークレットで設定
 */

const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const admin   = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── 環境変数 ───────────────────────────────────────────────
const LINE_CHANNEL_SECRET      = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY           = process.env.OPENAI_API_KEY; // 物件情報AI解析用

// ── Firebase 初期化 ────────────────────────────────────────
// Cloud Run では GOOGLE_APPLICATION_CREDENTIALS が自動で使われる
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

// ── ミドルウェア ───────────────────────────────────────────
// rawBody を保存（LINE署名検証のため JSON parse 前に必要）
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ── ヘルスチェック ─────────────────────────────────────────
app.get('/', (_req, res) => res.send('AIBO Webhook Server OK'));

// ── LINE Webhook エンドポイント ────────────────────────────
app.post('/webhook', async (req, res) => {
  // 1. 署名検証（必須）
  if (!verifyLineSignature(req)) {
    console.warn('署名検証失敗');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // LINEには200を即返す（タイムアウト防止）
  res.status(200).end();

  // 2. イベントを非同期処理
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
});

// ── 署名検証 ───────────────────────────────────────────────
function verifyLineSignature(req) {
  const signature = req.headers['x-line-signature'];
  if (!signature) return false;

  const hash = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(hash),
    Buffer.from(signature)
  );
}

// ── イベントルーター ───────────────────────────────────────
async function handleEvent(event) {
  const { type, source } = event;
  const userId = source?.userId;

  console.log(`[Event] type=${type} userId=${userId}`);

  switch (type) {
    case 'follow':
      // 友だち追加
      await handleFollow(userId);
      break;

    case 'message':
      await handleMessage(event, userId);
      break;

    case 'postback':
      await handlePostback(event, userId);
      break;

    default:
      console.log(`未対応イベント: ${type}`);
  }
}

// ── 友だち追加 ─────────────────────────────────────────────
async function handleFollow(userId) {
  // ユーザー情報をFirestoreに仮登録
  await db.collection('users').doc(userId).set({
    lineUserId: userId,
    registeredAt: admin.firestore.FieldValue.serverTimestamp(),
    plan: 'free',
    status: 'pending', // 本登録待ち
  }, { merge: true });

  // ウェルカムメッセージ + 登録URL案内
  const registerUrl = `https://aibo-system.web.app/register?lid=${userId}`;

  await lineReply(userId, [
    {
      type: 'flex',
      altText: 'AIBOへようこそ！',
      contents: buildWelcomeCard(registerUrl),
    }
  ]);
}

// ── メッセージ処理 ─────────────────────────────────────────
async function handleMessage(event, userId) {
  const { message } = event;

  // ユーザー状態を取得
  const userDoc = await db.collection('users').doc(userId).get();
  const user    = userDoc.exists ? userDoc.data() : {};
  const state   = user.state || 'default';

  if (message.type === 'text') {
    const text = message.text.trim();

    // ── コマンド判定 ──
    if (text === '物件登録' || text === '1') {
      return await startPropertyRegistration(userId);
    }
    if (text === '希望案件' || text === '2') {
      return await startRequestRegistration(userId);
    }
    if (text === '報酬確認' || text === '3') {
      return await sendRewardSummary(userId);
    }
    if (text === '商流確認' || text === '4') {
      return await sendFlowInfo(userId);
    }

    // ── 状態マシン ──
    if (state === 'awaiting_property_text') {
      return await parsePropertyText(userId, text);
    }
    if (state === 'awaiting_request_text') {
      return await savePropertyRequest(userId, text);
    }

    // ── デフォルト: AI判定 ──
    return await handleFreeText(userId, text);
  }

  if (message.type === 'image') {
    // 概要書の画像が送られた場合 → OCR + AI解析
    return await handlePropertyImage(userId, message.id);
  }

  if (message.type === 'audio') {
    // 音声メッセージ → Whisper API でテキスト変換
    return await handleAudioMessage(userId, message.id);
  }
}

// ── 物件テキスト AI解析 ────────────────────────────────────
async function parsePropertyText(userId, text) {
  await lineReply(userId, [{ type: 'text', text: '📋 物件情報を解析中です…' }]);

  try {
    const parsed = await extractPropertyDataWithAI(text);

    // Firestoreに保存
    const ref = await db.collection('properties').add({
      ...parsed,
      submittedBy: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'draft',
    });

    // ユーザー状態リセット
    await db.collection('users').doc(userId).update({ state: 'default' });

    // 商流確認フローを開始
    await startFlowVerification(userId, ref.id, parsed.propertyName);

    await lineReply(userId, [
      {
        type: 'flex',
        altText: '物件登録完了',
        contents: buildPropertyConfirmCard(parsed, ref.id),
      }
    ]);

  } catch (err) {
    console.error('AI解析エラー:', err);
    await lineReply(userId, [{ type: 'text', text: '解析に失敗しました。もう一度お送りください。' }]);
  }
}

// ── AI で物件情報を構造化 ─────────────────────────────────
async function extractPropertyDataWithAI(text) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `あなたは不動産の専門家です。
送られたテキストから物件情報を抽出し、以下のJSON形式で返してください。
値が不明な場合は null を使用してください。

{
  "propertyName": "物件名",
  "propertyType": "種別(土地/マンション/一棟ビル/戸建/その他)",
  "address": "所在地",
  "price": 価格(円・数値),
  "area": 面積(㎡・数値),
  "buildYear": 築年(西暦・数値),
  "structure": "構造(RC/SRC/木造/鉄骨)",
  "floors": 階数(数値),
  "landArea": 土地面積(㎡・数値),
  "currentUse": "現況",
  "zoning": "用途地域",
  "coverage": 建蔽率(数値・%),
  "floorRatio": 容積率(数値・%),
  "yieldRate": 利回り(数値・%),
  "monthlyRent": 月額賃料(円・数値),
  "remarks": "備考・特記事項",
  "merits": ["メリット1", "メリット2"],
  "demerits": ["デメリット1"],
  "risks": ["リスク1"]
}`
        },
        { role: 'user', content: text }
      ]
    },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  return JSON.parse(response.data.choices[0].message.content);
}

// ── 商流確認フロー開始 ─────────────────────────────────────
async function startFlowVerification(fromUserId, propertyId, propertyName) {
  // ユニークな商流コードを生成
  const flowCode = generateFlowCode();

  await db.collection('flowVerifications').doc(propertyId).set({
    propertyId,
    propertyName,
    chain: [{ userId: fromUserId, role: 'unknown', verifiedAt: null }],
    flowCode,
    status: 'in_progress',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 紹介元を確認するメッセージ
  await lineReply(fromUserId, [
    {
      type: 'flex',
      altText: '商流確認のお願い',
      contents: buildFlowVerificationCard(propertyName, flowCode, propertyId),
    }
  ]);
}

// ── ポストバック処理 ───────────────────────────────────────
async function handlePostback(event, userId) {
  const data = new URLSearchParams(event.postback.data);
  const action = data.get('action');

  switch (action) {
    case 'register_property':
      await startPropertyRegistration(userId);
      break;

    case 'flow_yes': {
      // 商流確認YES
      const propertyId = data.get('pid');
      const role       = data.get('role') || 'broker';
      await confirmFlowStep(userId, propertyId, role);
      break;
    }

    case 'set_role': {
      const propertyId = data.get('pid');
      const role       = data.get('role');
      await setUserRole(userId, propertyId, role);
      break;
    }

    case 'request_docs': {
      const propertyId = data.get('pid');
      await requestPropertyDocs(userId, propertyId);
      break;
    }
  }
}

// ── 商流ステップ確認 ───────────────────────────────────────
async function confirmFlowStep(userId, propertyId, role) {
  const flowRef = db.collection('flowVerifications').doc(propertyId);
  const flowDoc = await flowRef.get();
  if (!flowDoc.exists) return;

  const flow = flowDoc.data();

  // チェーンに追加
  const newChain = [
    ...flow.chain,
    { userId, role, verifiedAt: admin.firestore.FieldValue.serverTimestamp() }
  ];

  await flowRef.update({ chain: newChain });

  // 役割選択を促す
  await lineReply(userId, [
    {
      type: 'flex',
      altText: 'あなたの立場を教えてください',
      contents: buildRoleSelectCard(propertyId, flow.propertyName),
    }
  ]);
}

// ── 役割設定 + 次の商流確認 ────────────────────────────────
async function setUserRole(userId, propertyId, role) {
  const flowRef = db.collection('flowVerifications').doc(propertyId);
  const flowDoc = await flowRef.get();
  if (!flowDoc.exists) return;

  const flow  = flowDoc.data();
  const chain = flow.chain.map(c =>
    c.userId === userId ? { ...c, role } : c
  );

  await flowRef.update({ chain });

  if (role === 'seller') {
    // 売主に到達！本人確認書類を要求
    await lineReply(userId, [
      {
        type: 'flex',
        altText: '本人確認書類の提出をお願いします',
        contents: buildIdVerificationCard(propertyId, flow.propertyName),
      }
    ]);
    await flowRef.update({ status: 'reached_seller' });
    // 管理者に通知
    await notifyAdmin(
      `【商流到達】${flow.propertyName} の売主(${userId})に到達しました。`
    );

  } else {
    // まだ上流がいる — 紹介元を紹介してもらう
    const flowCode = generateFlowCode();
    await flowRef.update({ [`codes.${flowCode}`]: { forUserId: userId, createdAt: new Date() } });

    await lineReply(userId, [
      {
        type: 'text',
        text: `ありがとうございます。\nあなたにこの物件を教えた方に、以下のコードを共有してください。\n\n🔑 商流コード: ${flowCode}\n\n相手の方がコードを入力すると自動で繋がります。`
      }
    ]);
  }
}

// ── 報酬サマリー送信 ───────────────────────────────────────
async function sendRewardSummary(userId) {
  // ユーザーが関わる物件を検索
  const snapshot = await db.collection('properties')
    .where('submittedBy', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();

  if (snapshot.empty) {
    return lineReply(userId, [{ type: 'text', text: '関連する物件がまだありません。' }]);
  }

  const items = snapshot.docs.map(d => {
    const p = d.data();
    const reward = p.price ? Math.round(p.price * 0.0025) : null;
    return `📍 ${p.propertyName || '未設定'}\n   ステータス: ${p.status || '-'}\n   想定報酬: ${reward ? `¥${reward.toLocaleString()}` : '未確定'}`;
  });

  await lineReply(userId, [
    { type: 'text', text: `【あなたの報酬状況】\n\n${items.join('\n\n')}` }
  ]);
}

// ── フリーテキストをAIで処理 ──────────────────────────────
async function handleFreeText(userId, text) {
  // メインメニューを返す
  await lineReply(userId, [
    {
      type: 'flex',
      altText: 'AIBOメニュー',
      contents: buildMainMenu(),
    }
  ]);
}

// ── LINE返信 ──────────────────────────────────────────────
async function lineReply(to, messages) {
  // Push Message API（reply token不要）
  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to, messages },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      }
    }
  ).catch(e => console.error('LINE送信エラー:', e.response?.data || e.message));
}

// ── 管理者通知 ────────────────────────────────────────────
async function notifyAdmin(message) {
  const ADMIN_USER_ID = process.env.ADMIN_LINE_USER_ID;
  if (ADMIN_USER_ID) {
    await lineReply(ADMIN_USER_ID, [{ type: 'text', text: message }]);
  }
}

// ── ユーティリティ ────────────────────────────────────────
function generateFlowCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function startPropertyRegistration(userId) {
  await db.collection('users').doc(userId).update({ state: 'awaiting_property_text' });
  await lineReply(userId, [
    {
      type: 'text',
      text: '📝 物件情報を送ってください。\n\n概要書のテキストをそのまま貼り付けるか、以下の項目を入力してください。\n\n・物件名\n・所在地\n・価格\n・面積\n・種別\n・築年\n・利回り（あれば）\n・その他特記事項'
    }
  ]);
}

async function startRequestRegistration(userId) {
  await db.collection('users').doc(userId).update({ state: 'awaiting_request_text' });
  await lineReply(userId, [
    { type: 'text', text: '🔍 探している物件の条件を教えてください（エリア・予算・種別・用途など）' }
  ]);
}

async function savePropertyRequest(userId, text) {
  await db.collection('requests').add({
    userId,
    text,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    status: 'open',
  });
  await db.collection('users').doc(userId).update({ state: 'default' });

  // 全登録者にブロードキャスト（本番では Multicast API を使う）
  await lineReply(userId, [
    { type: 'text', text: '✅ リクエストを受け付けました！\n登録者全員にお知らせします。マッチした物件が見つかり次第ご連絡します。' }
  ]);
}

async function sendFlowInfo(userId) {
  const snapshot = await db.collection('flowVerifications')
    .where('chain', 'array-contains', { userId, role: 'unknown', verifiedAt: null })
    .limit(3)
    .get();

  await lineReply(userId, [{
    type: 'text',
    text: snapshot.empty
      ? '現在確認中の商流はありません。'
      : `${snapshot.size}件の商流確認が進行中です。\nWebダッシュボードで詳細を確認できます。\nhttps://aibo-system.web.app/flow`
  }]);
}

// ───────────────────────────────────────────────────────────
// Flex Message テンプレート
// ───────────────────────────────────────────────────────────

function buildWelcomeCard(registerUrl) {
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      backgroundColor: '#0a0c10',
      contents: [{ type: 'text', text: 'AIBO', size: '3xl', weight: 'bold', color: '#00e5a0', align: 'center' }]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md',
      contents: [
        { type: 'text', text: 'AI不動産管理システムへようこそ！', weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: 'まずは無料登録をして、物件情報の登録・閲覧・報酬受取を始めましょう。', size: 'sm', color: '#7a8599', wrap: true },
        { type: 'separator' },
        { type: 'text', text: '✅ 無料でできること', weight: 'bold', size: 'sm' },
        { type: 'text', text: '・物件情報の登録・閲覧\n・希望案件リクエスト\n・紹介報酬の受取（0.5%を分配）', size: 'sm', color: '#7a8599', wrap: true },
        { type: 'text', text: '⭐ PRO会員（¥3,300/月）', weight: 'bold', size: 'sm', color: '#f0b429' },
        { type: 'text', text: '・報酬+0.1%\n・優先掲載\n・商流図エクスポート', size: 'sm', color: '#7a8599', wrap: true },
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        {
          type: 'button', style: 'primary', color: '#00e5a0',
          action: { type: 'uri', label: '📝 無料登録はこちら', uri: registerUrl }
        },
        {
          type: 'button', style: 'secondary',
          action: { type: 'message', label: 'メニューを見る', text: 'メニュー' }
        }
      ]
    }
  };
}

function buildMainMenu() {
  return {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: 'AIBOメニュー', weight: 'bold', size: 'lg' },
        { type: 'separator' },
        ...[
          ['1', '🏢 物件登録', '概要書・テキストから登録'],
          ['2', '🔍 希望案件', '探している物件を登録'],
          ['3', '💰 報酬確認', '自分の報酬・進捗を確認'],
          ['4', '🔗 商流確認', '紹介ルートの状況を確認'],
        ].map(([num, label, desc]) => ({
          type: 'box', layout: 'horizontal', paddingAll: 'sm',
          action: { type: 'message', label, text: num },
          contents: [
            { type: 'text', text: label, flex: 3, size: 'sm', weight: 'bold' },
            { type: 'text', text: desc, flex: 5, size: 'xs', color: '#7a8599' },
          ]
        }))
      ]
    }
  };
}

function buildPropertyConfirmCard(data, propertyId) {
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#0a1a14',
      contents: [{ type: 'text', text: '✅ 物件登録完了', weight: 'bold', color: '#00e5a0' }]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: data.propertyName || '物件名未設定', weight: 'bold', size: 'lg', wrap: true },
        { type: 'text', text: data.address || '-', size: 'sm', color: '#7a8599', wrap: true },
        { type: 'separator' },
        row('価格', data.price ? `¥${Number(data.price).toLocaleString()}` : '-'),
        row('面積', data.area ? `${data.area}㎡` : '-'),
        row('種別', data.propertyType || '-'),
        row('利回り', data.yieldRate ? `${data.yieldRate}%` : '-'),
        ...(data.merits?.length ? [
          { type: 'text', text: '📈 メリット', weight: 'bold', size: 'sm', margin: 'md' },
          ...data.merits.map(m => ({ type: 'text', text: `・${m}`, size: 'sm', color: '#00e5a0', wrap: true }))
        ] : []),
        ...(data.risks?.length ? [
          { type: 'text', text: '⚠️ リスク', weight: 'bold', size: 'sm', margin: 'md', color: '#ff6b35' },
          ...data.risks.map(r => ({ type: 'text', text: `・${r}`, size: 'sm', color: '#ff6b35', wrap: true }))
        ] : []),
      ]
    },
    footer: {
      type: 'box', layout: 'vertical',
      contents: [{
        type: 'button', style: 'primary', color: '#0077ff',
        action: { type: 'uri', label: '📊 Webで詳細を見る', uri: `https://aibo-system.web.app/properties/${propertyId}` }
      }]
    }
  };
}

function buildFlowVerificationCard(propertyName, flowCode, propertyId) {
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#0a0f1a',
      contents: [{ type: 'text', text: '🔗 商流確認のお願い', weight: 'bold', color: '#0077ff' }]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md',
      contents: [
        { type: 'text', text: `「${propertyName}」の情報をお持ちいただきありがとうございます。`, size: 'sm', wrap: true },
        { type: 'text', text: 'スムーズな取引のため、この情報を教えてくれた方を確認させてください。', size: 'sm', color: '#7a8599', wrap: true },
        { type: 'separator' },
        { type: 'text', text: `🔑 商流コード: ${flowCode}`, weight: 'bold', size: 'md', color: '#f0b429' },
        { type: 'text', text: 'このコードを、あなたに情報をくれた方に共有してください。', size: 'xs', color: '#7a8599', wrap: true },
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        {
          type: 'button', style: 'primary', color: '#0077ff',
          action: { type: 'postback', label: '✅ 私が売主（当事者）です', data: `action=set_role&pid=${propertyId}&role=seller` }
        },
        {
          type: 'button', style: 'secondary',
          action: { type: 'postback', label: '私は仲介・紹介者です', data: `action=set_role&pid=${propertyId}&role=broker` }
        }
      ]
    }
  };
}

function buildRoleSelectCard(propertyId, propertyName) {
  return {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'md',
      contents: [
        { type: 'text', text: '「' + propertyName + '」について', size: 'sm', color: '#7a8599', wrap: true },
        { type: 'text', text: 'あなたの立場を教えてください', weight: 'bold', size: 'lg', wrap: true },
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', color: '#00e5a0', action: { type: 'postback', label: '🏠 売主（所有者）', data: `action=set_role&pid=${propertyId}&role=seller` } },
        { type: 'button', style: 'secondary', action: { type: 'postback', label: '📋 元付け（媒介契約あり）', data: `action=set_role&pid=${propertyId}&role=agent` } },
        { type: 'button', style: 'secondary', action: { type: 'postback', label: '🤝 仲介・紹介者', data: `action=set_role&pid=${propertyId}&role=broker` } },
      ]
    }
  };
}

function buildIdVerificationCard(propertyId, propertyName) {
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#1a0a0a',
      contents: [{ type: 'text', text: '🏠 売主様へ', weight: 'bold', color: '#ff6b35' }]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md',
      contents: [
        { type: 'text', text: `「${propertyName}」の売主様として確認が取れました。`, size: 'sm', wrap: true },
        { type: 'text', text: '本人確認のため、以下をご提出ください。', size: 'sm', color: '#7a8599', wrap: true },
        { type: 'text', text: '・運転免許証または\n  マイナンバーカード（表面）の\n  写真をこのLINEに送信', size: 'sm', wrap: true },
        { type: 'separator' },
        { type: 'text', text: '確認後、AIBOから直接ご挨拶のメッセージをお送りします。', size: 'xs', color: '#7a8599', wrap: true },
      ]
    }
  };
}

function row(label, value) {
  return {
    type: 'box', layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#7a8599', flex: 3 },
      { type: 'text', text: value, size: 'sm', weight: 'bold', flex: 5, align: 'end' }
    ]
  };
}

// ── サーバー起動 ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AIBO Webhook Server listening on port ${PORT}`);
});
