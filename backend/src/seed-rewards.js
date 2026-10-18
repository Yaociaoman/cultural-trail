// 示意獎勵種子資料：合作店家尚未洽談，名稱與說明都標註「示意」。
// 執行：在 backend/ 下 `npm run seed:rewards`；重複執行只會更新內容，不會重設庫存。
// 正式合作確定後，把 active 改成 0 或刪除 demo- 開頭的獎勵即可。
import 'dotenv/config';
import { db, transaction } from './db.js';

const demoRewards = [
  {
    id: 'demo-postcard-set',
    name: '【示意】文化景點明信片組',
    description: '在地插畫家繪製的景點明信片 5 張，使用再生紙印刷。合作店家洽談中，此為展示用獎勵。',
    cost: 30,
    stock: 100
  },
  {
    id: 'demo-bike-rental',
    name: '【示意】低碳單車租借 2 小時',
    description: '於合作租車點出示兌換紀錄，免費租借單車 2 小時，以低碳方式串連景點。合作店家洽談中，此為展示用獎勵。',
    cost: 40,
    stock: 50
  },
  {
    id: 'demo-farmers-market-coupon',
    name: '【示意】小農市集 NT$100 折價券',
    description: '於合作的在地小農市集消費折抵 NT$100，支持在地生產、減少運輸碳排。合作店家洽談中，此為展示用獎勵。',
    cost: 50,
    stock: 50
  },
  {
    id: 'demo-organic-tea',
    name: '【示意】臺灣有機茶包組',
    description: '在地有機茶園的茶包組，採無塑包裝。合作店家洽談中，此為展示用獎勵。',
    cost: 60,
    stock: 40
  },
  {
    id: 'demo-eco-tote',
    name: '【示意】文創帆布購物袋',
    description: '印有臺灣老街圖樣的文創帆布袋，可重複使用、減少一次性塑膠袋。合作店家洽談中，此為展示用獎勵。',
    cost: 80,
    stock: 30
  },
  {
    id: 'demo-craft-workshop',
    name: '【示意】傳統工藝體驗課 8 折券',
    description: '藍染、竹編或陶藝等傳統工藝體驗課程 8 折優惠，支持在地工藝工作者。合作店家洽談中，此為展示用獎勵。',
    cost: 120,
    stock: 20
  }
];

const upsert = db.prepare(`
INSERT INTO rewards(id,name,description,cost,active,stock)
VALUES (@id,@name,@description,@cost,1,@stock)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  description=excluded.description,
  cost=excluded.cost,
  active=1
`);

transaction(() => demoRewards.forEach(reward => upsert.run(reward)));
console.log(`已寫入 ${demoRewards.length} 筆示意獎勵。`);
