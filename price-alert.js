// === IMPORT MODULES ===
import "dotenv/config";
import axios from "axios";
import notifier from "node-notifier";
import TelegramBot from "node-telegram-bot-api";
import Decimal from "decimal.js";
import http from "http";

// === TELEGRAM CONFIG ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true }); // Bật polling để nhận lệnh

// === DANH SÁCH POOL CẦN THEO DÕI (có thể thêm/xóa động qua bot) ===
const poolConfigs = [];

const RPC_URL = "https://fullnode.mainnet.sui.io/";
const interval = 60 * 1000 * 5; // kiểm tra mỗi 5 phút

// === TRẠNG THÁI LƯU CẢNH BÁO (ĐỂ KHÔNG LẶP LẠI) ===
const alertStatus = {}; // { poolId: 'inside' | 'outside' }

// === TÍNH NĂNG THEO DÕI BỔ SUNG (TOGGLE) ===
const trackingFeatures = {
  oneHourWarning: true, // Cảnh báo sau 1 tiếng ngoài vùng
  backInRangeAlert: true, // Thông báo khi giá trở lại trong vùng
};

// === TRACKING THỜI GIAN NGOÀI VÙNG ===
const outsideRangeTimestamp = {}; // { poolId: timestamp }
const lastHourlyWarning = {}; // { poolId: timestamp } - lần cảnh báo hourly gần nhất

// === TRACKING THỜI GIAN TRONG VÙNG (IN RANGE) ===
const inRangeStartTime = {}; // { poolId: timestamp } - thời điểm bắt đầu trong range
const totalInRangeTime = {}; // { poolId: milliseconds } - tổng thời gian đã trong range

// === HÀM TÍNH GIÁ TỪ sqrt_price ===
// Công thức CLMM cho Momentum/Sui: price = (sqrtPriceX64 / 2^64)^2
// Momentum sử dụng Q64 thay vì Q96 như Uniswap V3
function calcPriceFromSqrt(
  sqrtPriceStr,
  decimals0 = 6,
  decimals1 = 6,
  invert = false
) {
  const sqrtPrice = new Decimal(sqrtPriceStr);
  const Q64 = new Decimal(2).pow(64);

  // Tính price từ sqrt_price
  const ratio = sqrtPrice.div(Q64);
  let price = ratio.pow(2);

  // Điều chỉnh theo decimal difference
  const decimalAdjustment = new Decimal(10).pow(decimals0 - decimals1);
  price = price.mul(decimalAdjustment);

  // Nếu cần đảo ngược (token0/token1 thay vì token1/token0)
  if (invert) {
    price = new Decimal(1).div(price);
  }

  return parseFloat(price.toFixed(10));
}

// === HÀM TÍNH TỔNG THỜI GIAN TRONG RANGE ===
function getTotalInRangeTime(poolId) {
  const currentTime = Date.now();
  let total = totalInRangeTime[poolId] || 0;
  
  // Nếu hiện tại đang trong range, cộng thêm thời gian từ lúc bắt đầu đến giờ
  if (inRangeStartTime[poolId]) {
    total += currentTime - inRangeStartTime[poolId];
  }
  
  return total;
}

// === HÀM FORMAT THỜI GIAN ===
function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    const remainingHours = hours % 24;
    return `${days} ngày ${remainingHours}h`;
  } else if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${seconds}s`;
  }
}

// === HÀM FORMAT NGÀY GIỜ (GMT+7) ===
function formatDateTime() {
  return new Date().toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatTime() {
  return new Date().toLocaleTimeString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false
  });
}

// === HÀM LẤY DỮ LIỆU ON-CHAIN TỪ RPC ===
async function getPoolData(poolId, config) {
  try {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "sui_multiGetObjects",
      params: [[poolId], { showType: true, showContent: true }],
    };

    const res = await axios.post(RPC_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });

    // Một số node trả result dạng object, một số dạng mảng
    const result = res.data.result;
    let pool;

    if (Array.isArray(result)) {
      pool = result[0]?.data?.content?.fields;
    } else if (result?.data) {
      // trường hợp chuẩn nhất của RPC
      pool = result.data[0]?.data?.content?.fields;
    }

    // Debug nhẹ để xem cấu trúc khi không thấy dữ liệu
    if (!pool) {
      console.log("⚠️ RPC phản hồi không có content.fields:");
      console.dir(res.data, { depth: 3 });
      return null;
    }

    if (!pool.sqrt_price) {
      console.log("⚠️ Không có sqrt_price trong pool:", poolId);
      console.dir(pool, { depth: 2 });
      return null;
    }

    const price = calcPriceFromSqrt(
      pool.sqrt_price,
      config.decimals0 || 6,
      config.decimals1 || 6,
      config.invert || false
    );
    return price;
  } catch (err) {
    console.error(`❌ Lỗi RPC ${poolId}:`, err.message);
    return null;
  }
}

// === HÀM CHÍNH KIỂM TRA GIÁ ===
async function checkPools() {
  const now = formatTime();
  const currentTime = Date.now();

  for (const config of poolConfigs) {
    const price = await getPoolData(config.id, config);
    if (!price) {
      console.log(`⚠️ Không thể lấy giá cho ${config.name}`);
      continue;
    }

    const prevStatus = alertStatus[config.id] || "inside";
    const isOutside = price < config.min || price > config.max;

    // Hiển thị console
    console.log(
      `[${now}] ${config.name}: ${price.toFixed(8)} | Range: ${config.min}–${
        config.max
      }`
    );

    if (isOutside && prevStatus === "inside") {
      // → mới vượt vùng → gửi cảnh báo
      const message = `⚠️ *${config.name}* ngoài vùng ${config.min}–${
        config.max
      }\nGiá hiện tại: *${price.toFixed(8)}*\n⏰ ${now}`;
      notifier.notify({
        title: `${config.name} Price Alert`,
        message: `Giá hiện tại: ${price.toFixed(8)} (ngoài vùng ${config.min}–${
          config.max
        })`,
        sound: true,
      });
      await bot.sendMessage(CHAT_ID, message, { parse_mode: "Markdown" });

      alertStatus[config.id] = "outside";
      
      // Lưu thời điểm bắt đầu ngoài vùng
      outsideRangeTimestamp[config.id] = currentTime;
      lastHourlyWarning[config.id] = currentTime; // Lần đầu ra ngoài vùng cũng là lần cảnh báo đầu
      
      // Cập nhật tổng thời gian trong range trước khi ra ngoài
      if (inRangeStartTime[config.id]) {
        const timeInRange = currentTime - inRangeStartTime[config.id];
        totalInRangeTime[config.id] = (totalInRangeTime[config.id] || 0) + timeInRange;
        delete inRangeStartTime[config.id]; // Dừng đếm khi ra ngoài range
      }
      
    } else if (!isOutside && prevStatus === "outside") {
      // → quay lại vùng an toàn → gửi thông báo 1 lần
      if (trackingFeatures.backInRangeAlert) {
        const message = `✅ *${
          config.name
        }* đã quay lại vùng an toàn.\nGiá hiện tại: *${price.toFixed(
          8
        )}*\n⏰ ${now}`;
        notifier.notify({
          title: `${config.name} Price Recovered`,
          message: `Giá hiện tại: ${price.toFixed(8)} (đã trong vùng ${
            config.min
          }–${config.max})`,
        });
        await bot.sendMessage(CHAT_ID, message, { parse_mode: "Markdown" });
      }

      alertStatus[config.id] = "inside";
      
      // Reset tracking khi quay lại vùng an toàn
      delete outsideRangeTimestamp[config.id];
      delete lastHourlyWarning[config.id];
      
      // Bắt đầu đếm thời gian trong range lại
      inRangeStartTime[config.id] = currentTime;
      
    } else if (isOutside && prevStatus === "outside") {
      // → vẫn đang ngoài vùng → kiểm tra xem đã quá 1 tiếng kể từ lần cảnh báo trước chưa
      if (trackingFeatures.oneHourWarning && 
          outsideRangeTimestamp[config.id] && 
          lastHourlyWarning[config.id]) {
        
        const timeSinceLastWarning = currentTime - lastHourlyWarning[config.id];
        const oneHourInMs = 60 * 60 * 1000; // 1 giờ = 3,600,000 ms
        
        if (timeSinceLastWarning >= oneHourInMs) {
          // Tính tổng thời gian đã ngoài vùng
          const totalTimeOutside = currentTime - outsideRangeTimestamp[config.id];
          const hoursOutside = Math.floor(totalTimeOutside / oneHourInMs);
          
          const message = `⏰ *CẢNH BÁO:* ${config.name} đã ngoài vùng ${hoursOutside} tiếng!\n\n` +
            `Giá hiện tại: *${price.toFixed(8)}*\n` +
            `Range: ${config.min}–${config.max}\n\n` +
            `💡 _Hãy cân nhắc cập nhật lại min/max!_\n` +
            `⏰ ${now}`;
          
          notifier.notify({
            title: `${config.name} - ${hoursOutside}h Outside Range`,
            message: `Đã ngoài vùng ${hoursOutside} tiếng! Giá: ${price.toFixed(8)}`,
            sound: true,
          });
          
          await bot.sendMessage(CHAT_ID, message, { parse_mode: "Markdown" });
          lastHourlyWarning[config.id] = currentTime; // Cập nhật thời gian cảnh báo mới nhất
        }
      }
    }
  }

  console.log("—");
}

// === TELEGRAM BOT COMMANDS ===

// Hàm tạo menu button
function getMainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "📊 Pools" }, { text: "📈 Giá" }],
        [{ text: "➕ Thêm" }, { text: "✏️ Sửa" }, { text: "🗑️ Xóa" }],
        [{ text: "⚙️ Toggle" }, { text: "❓ Help" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

// Handler: Help/Start
function handleHelp(msg) {
  const helpText = `
🤖 *MMT Price Alert Bot*

Chào mừng! Sử dụng các nút bên dưới để thao tác với bot.

📋 *Chức năng:*
• 📊 Pools - Xem danh sách pools
• 📈 Giá - Kiểm tra giá real-time
• ➕ Thêm - Thêm pool mới
• ✏️ Sửa - Sửa ngưỡng min/max
• 🗑️ Xóa - Xóa pool
• ⚙️ Toggle - Bật/tắt tính năng theo dõi
• ❓ Help - Xem hướng dẫn

📝 *Cách thêm pool:*
Nhấn "➕ Thêm" rồi gửi thông tin:
\`\`\`
PoolID
PoolName
Min
Max
Invert (true/false - optional)
\`\`\`

*Ví dụ:*
\`\`\`
0xb556fc22cef...
FDUSD/USDC
0.998
1.002
false
\`\`\`

🔔 *Tính năng theo dõi:*
• Cảnh báo sau 1h ngoài vùng
• Thông báo khi giá trở lại trong vùng
_(Dùng ⚙️ Toggle để bật/tắt)_
  `;
  bot.sendMessage(msg.chat.id, helpText, {
    parse_mode: "Markdown",
    ...getMainMenu(),
  });
}

// /start - Hướng dẫn sử dụng
bot.onText(/\/start/, handleHelp);

// /help
bot.onText(/\/help/, handleHelp);

// Xử lý button text
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Xử lý button menu
  if (text === "📊 Pools" || text === "/list") {
    handleListPools(msg);
    return;
  }
  
  if (text === "📈 Giá" || text === "/status") {
    handleStatus(msg);
    return;
  }
  
  if (text === "➕ Thêm" || text === "/add") {
    handleAddPool(msg);
    return;
  }
  
  if (text === "✏️ Sửa" || text === "/edit") {
    handleEditPool(msg);
    return;
  }
  
  if (text === "🗑️ Xóa" || text === "/remove") {
    handleRemovePool(msg);
    return;
  }
  
  if (text === "⚙️ Toggle" || text === "/toggle") {
    handleToggleFeatures(msg);
    return;
  }
  
  if (text === "❓ Help" || text === "/help" || text === "/start") {
    handleHelp(msg);
    return;
  }

  // Bỏ qua nếu là lệnh khác
  if (text.startsWith("/")) return;

  // Xử lý các thao tác nhập liệu (add/edit/remove pool)
  handleUserInput(msg);
});

// === HANDLER FUNCTIONS ===

// Handler: Xem danh sách pools
function handleListPools(msg) {
  if (poolConfigs.length === 0) {
    bot.sendMessage(msg.chat.id, "📭 Chưa có pool nào được theo dõi.", getMainMenu());
    return;
  }

  let message = "📊 *Danh sách Pools đang theo dõi:*\n\n";
  poolConfigs.forEach((pool, index) => {
    const status = alertStatus[pool.id] || "inside";
    const emoji = status === "inside" ? "✅" : "⚠️";
    message += `${emoji} *${index + 1}. ${pool.name}*\n`;
    message += `   ID: \`${pool.id.substring(0, 20)}...\`\n`;
    message += `   Range: ${pool.min} - ${pool.max}\n`;
    message += `   Invert: ${pool.invert}\n\n`;
  });

  bot.sendMessage(msg.chat.id, message, { 
    parse_mode: "Markdown",
    ...getMainMenu()
  });
}

// /list - Xem danh sách pools (legacy command support)
bot.onText(/\/list/, handleListPools);

// Handler: Xem trạng thái và giá hiện tại
async function handleStatus(msg) {
  bot.sendMessage(msg.chat.id, "🔄 Đang kiểm tra giá...");

  if (poolConfigs.length === 0) {
    bot.sendMessage(msg.chat.id, "📭 Chưa có pool nào được theo dõi.", getMainMenu());
    return;
  }

  let message = "📈 *Giá hiện tại:*\n\n";

  for (const config of poolConfigs) {
    const price = await getPoolData(config.id, config);
    if (!price) {
      message += `❌ *${config.name}*: Không lấy được giá\n\n`;
      continue;
    }

    const isOutside = price < config.min || price > config.max;
    const emoji = isOutside ? "⚠️" : "✅";
    const statusText = isOutside ? "NGOÀI VÙNG" : "Bình thường";
    
    // Tính thời gian trong range
    const totalTime = getTotalInRangeTime(config.id);
    const timeStr = formatDuration(totalTime);

    message += `${emoji} *${config.name}*\n`;
    message += `   Giá: \`${price.toFixed(8)}\` (${statusText})\n`;
    message += `   Range: ${config.min} - ${config.max}\n`;
    message += `   ⏱️ Thời gian trong range: ${timeStr}\n\n`;
  }

  bot.sendMessage(msg.chat.id, message, { 
    parse_mode: "Markdown",
    ...getMainMenu()
  });
}

// /status - legacy command support
bot.onText(/\/status/, handleStatus);

// Handler: Toggle tracking features
function handleToggleFeatures(msg) {
  const chatId = msg.chat.id;
  
  const statusEmoji = (enabled) => enabled ? "✅" : "❌";
  
  const message = `⚙️ *Cài đặt tính năng theo dõi*\n\n` +
    `${statusEmoji(trackingFeatures.oneHourWarning)} *1. Cảnh báo sau 1h ngoài vùng*\n` +
    `   Gửi cảnh báo nếu giá ngoài vùng quá 1 tiếng mà chưa cập nhật min/max\n\n` +
    `${statusEmoji(trackingFeatures.backInRangeAlert)} *2. Thông báo khi giá trở lại vùng*\n` +
    `   Thông báo khi giá từ ngoài vùng quay lại trong vùng an toàn\n\n` +
    `📝 *Để bật/tắt:*\n` +
    `Gửi số tính năng muốn toggle (1 hoặc 2)\n` +
    `Ví dụ: gửi \`1\` để toggle tính năng cảnh báo 1h\n\n` +
    `Hoặc gửi /cancel để hủy.`;
  
  pendingAddPool[chatId] = "toggle";
  
  bot.sendMessage(chatId, message, { 
    parse_mode: "Markdown",
    ...getMainMenu()
  });
}

// /toggle - legacy command support
bot.onText(/\/toggle/, handleToggleFeatures);

// Handler: Thêm pool mới
function handleAddPool(msg) {
  const chatId = msg.chat.id;
  pendingAddPool[chatId] = true;

  const instruction = `
📝 *Thêm Pool Mới*

Vui lòng gửi thông tin theo format (mỗi dòng một thông tin):

\`\`\`
PoolID
PoolName
Min
Max
Invert (true/false - optional)
\`\`\`

*Ví dụ đầy đủ:*
\`\`\`
0xb556fc22cef37bee2ab045bfbbd370f4080db5f6f2dd35a8eff3699ddf48e454
FDUSD/USDC
0.998
1.002
false
\`\`\`

*Hoặc bỏ invert (mặc định false):*
\`\`\`
0xb556fc22cef37bee2ab045bfbbd370f4080db5f6f2dd35a8eff3699ddf48e454
FDUSD/USDC
0.998
1.002
\`\`\`

Gửi /cancel để hủy.
  `;

  bot.sendMessage(chatId, instruction, { 
    parse_mode: "Markdown",
    ...getMainMenu()
  });
}

// /add - legacy command support  
bot.onText(/\/add/, handleAddPool);

// Lưu trạng thái đang chờ nhập thông tin
let pendingAddPool = {};

// Handler: Sửa pool
function handleEditPool(msg) {
  const chatId = msg.chat.id;

  if (poolConfigs.length === 0) {
    bot.sendMessage(chatId, "📭 Chưa có pool nào để sửa.", getMainMenu());
    return;
  }

  let message = "✏️ *Chọn pool để sửa min/max:*\n\n";
  poolConfigs.forEach((pool, index) => {
    message += `${index + 1}. ${pool.name} (Range: ${pool.min} - ${
      pool.max
    })\n`;
  });
  message += `\nGửi số thứ tự pool cần sửa (ví dụ: 1)`;

  pendingAddPool[chatId] = "edit";
  bot.sendMessage(chatId, message, { 
    parse_mode: "Markdown",
    ...getMainMenu()
  });
}

// /edit - Sửa min/max của pool
bot.onText(/\/edit/, handleEditPool);

// Handler: Xóa pool
function handleRemovePool(msg) {
  const chatId = msg.chat.id;

  if (poolConfigs.length === 0) {
    bot.sendMessage(chatId, "📭 Chưa có pool nào để xóa.", getMainMenu());
    return;
  }

  let message = "🗑️ *Chọn pool để xóa:*\n\n";
  poolConfigs.forEach((pool, index) => {
    message += `${index + 1}. ${pool.name}\n`;
  });
  message += `\nGửi số thứ tự pool cần xóa (ví dụ: 1)`;

  pendingAddPool[chatId] = "remove";
  bot.sendMessage(chatId, message, { 
    parse_mode: "Markdown",
    ...getMainMenu()
  });
}

// /remove - Xóa pool
bot.onText(/\/remove/, handleRemovePool);

// /cancel - Hủy thao tác
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  delete pendingAddPool[chatId];
  bot.sendMessage(chatId, "❌ Đã hủy thao tác.", getMainMenu());
});

// === XỬ LÝ NHẬP LIỆU (ADD/EDIT/REMOVE POOL) ===
function handleUserInput(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Xử lý toggle features
  if (pendingAddPool[chatId] === "toggle") {
    const choice = parseInt(text);
    
    if (choice === 1) {
      trackingFeatures.oneHourWarning = !trackingFeatures.oneHourWarning;
      const status = trackingFeatures.oneHourWarning ? "BẬT" : "TẮT";
      bot.sendMessage(
        chatId,
        `✅ Đã *${status}* tính năng "Cảnh báo sau 1h ngoài vùng"`,
        { parse_mode: "Markdown", ...getMainMenu() }
      );
      delete pendingAddPool[chatId];
      return;
    } else if (choice === 2) {
      trackingFeatures.backInRangeAlert = !trackingFeatures.backInRangeAlert;
      const status = trackingFeatures.backInRangeAlert ? "BẬT" : "TẮT";
      bot.sendMessage(
        chatId,
        `✅ Đã *${status}* tính năng "Thông báo khi giá trở lại vùng"`,
        { parse_mode: "Markdown", ...getMainMenu() }
      );
      delete pendingAddPool[chatId];
      return;
    } else {
      bot.sendMessage(chatId, "❌ Vui lòng gửi 1 hoặc 2. Hoặc /cancel để hủy.");
      return;
    }
  }

  // Xử lý sửa pool - bước 1: chọn pool
  if (pendingAddPool[chatId] === "edit") {
    const index = parseInt(text) - 1;

    if (isNaN(index) || index < 0 || index >= poolConfigs.length) {
      bot.sendMessage(chatId, "❌ Số thứ tự không hợp lệ. Vui lòng thử lại.");
      return;
    }

    const pool = poolConfigs[index];
    pendingAddPool[chatId] = { mode: "edit-values", poolIndex: index };

    bot.sendMessage(
      chatId,
      `✏️ Sửa *${pool.name}*\n\nGửi Min và Max mới (2 dòng):\n\`\`\`\nMin\nMax\n\`\`\`\n\n*Ví dụ:*\n\`\`\`\n0.997\n1.003\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Xử lý sửa pool - bước 2: nhập min/max mới
  if (pendingAddPool[chatId]?.mode === "edit-values") {
    const lines = text.trim().split("\n");

    if (lines.length !== 2) {
      bot.sendMessage(
        chatId,
        "❌ Cần đúng 2 dòng (Min và Max). Vui lòng thử lại hoặc gửi /cancel."
      );
      return;
    }

    const [minStr, maxStr] = lines;
    const min = parseFloat(minStr);
    const max = parseFloat(maxStr);

    if (isNaN(min) || isNaN(max)) {
      bot.sendMessage(
        chatId,
        "❌ Dữ liệu không hợp lệ! Kiểm tra lại min, max."
      );
      return;
    }

    const poolIndex = pendingAddPool[chatId].poolIndex;
    const pool = poolConfigs[poolIndex];

    pool.min = min;
    pool.max = max;

    // Reset trạng thái cảnh báo để nhận alert mới với ngưỡng mới
    alertStatus[pool.id] = "inside";
    
    // Reset tracking timestamp và cảnh báo hourly
    delete outsideRangeTimestamp[pool.id];
    delete lastHourlyWarning[pool.id];
    
    // Reset hoàn toàn thời gian tracking trong range
    totalInRangeTime[pool.id] = 0;
    inRangeStartTime[pool.id] = Date.now();

    delete pendingAddPool[chatId];

    bot.sendMessage(
      chatId,
      `✅ *Đã cập nhật ${pool.name}*\n\nRange mới: ${min} - ${max}\n\n_Trạng thái cảnh báo và thời gian tracking đã được reset về 0_`,
      { parse_mode: "Markdown", ...getMainMenu() }
    );
    return;
  }

  // Xử lý xóa pool
  if (pendingAddPool[chatId] === "remove") {
    const index = parseInt(text) - 1;

    if (isNaN(index) || index < 0 || index >= poolConfigs.length) {
      bot.sendMessage(chatId, "❌ Số thứ tự không hợp lệ. Vui lòng thử lại.");
      return;
    }

    const removedPool = poolConfigs.splice(index, 1)[0];
    
    // Xóa tất cả tracking data của pool
    delete alertStatus[removedPool.id];
    delete outsideRangeTimestamp[removedPool.id];
    delete lastHourlyWarning[removedPool.id];
    delete inRangeStartTime[removedPool.id];
    delete totalInRangeTime[removedPool.id];
    
    delete pendingAddPool[chatId];

    bot.sendMessage(chatId, `✅ Đã xóa pool: *${removedPool.name}*`, {
      parse_mode: "Markdown",
      ...getMainMenu()
    });
    return;
  }

  // Xử lý thêm pool
  if (pendingAddPool[chatId] === true) {
    const lines = text.trim().split("\n");

    if (lines.length < 4 || lines.length > 5) {
      bot.sendMessage(
        chatId,
        "❌ Thiếu thông tin! Cần 4-5 dòng. Vui lòng thử lại hoặc gửi /cancel."
      );
      return;
    }

    const [poolId, poolName, minStr, maxStr, invertStr] = lines;

    const min = parseFloat(minStr);
    const max = parseFloat(maxStr);
    const invert = invertStr ? invertStr.toLowerCase() === "true" : false;

    if (isNaN(min) || isNaN(max)) {
      bot.sendMessage(
        chatId,
        "❌ Dữ liệu không hợp lệ! Kiểm tra lại min, max."
      );
      return;
    }

    const newPool = {
      id: poolId.trim(),
      name: poolName.trim(),
      min,
      max,
      decimals0: 6, // Mặc định 6 (phổ biến cho stablecoins)
      decimals1: 6, // Mặc định 6
      invert,
    };

    poolConfigs.push(newPool);
    
    // Khởi tạo tracking thời gian trong range cho pool mới
    inRangeStartTime[newPool.id] = Date.now();
    totalInRangeTime[newPool.id] = 0;
    
    delete pendingAddPool[chatId];

    bot.sendMessage(
      chatId,
      `✅ *Đã thêm pool mới:*\n\n*${newPool.name}*\nRange: ${min} - ${max}\nInvert: ${invert}\n\n_Decimals mặc định: 6/6_\n_Bắt đầu theo dõi thời gian trong range_`,
      { 
        parse_mode: "Markdown",
        ...getMainMenu()
      }
    );
  }
}

// === CHẠY LIÊN TỤC ===
console.log("🚀 MMT On-chain Price Alert (SUI RPC) đang chạy...");
checkPools();
setInterval(checkPools, interval);


// === HTTP SERVER (CHO RENDER WEB SERVICE) ===
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "running",
        bot: "MMT Price Alert",
        pools: poolConfigs.length,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT} (for Render health check)`);
});

// === KEEP-ALIVE: TỰ ĐỘNG PING ĐỂ GIỮ SERVER HOẠT ĐỘNG ===
// Chỉ chạy khi có biến môi trường REPL_SLUG (chỉ có trên Replit)
if (process.env.REPL_SLUG) {
  const REPLIT_URL = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
  
  // Ping mỗi 4 phút để giữ Replit không ngủ (Replit timeout sau ~5 phút không activity)
  setInterval(() => {
    axios.get(`${REPLIT_URL}/health`)
      .then(() => {
        console.log(`🔄 [${formatTime()}] Keep-alive ping successful`);
      })
      .catch(err => {
        console.error(`⚠️ Keep-alive ping failed:`, err.message);
      });
  }, 3 * 60 * 1000); // 3 phút
  
  console.log(`🔄 Keep-alive enabled cho Replit: ${REPLIT_URL}`);
}
