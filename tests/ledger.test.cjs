const {test} = require("node:test");
const assert = require("node:assert/strict");
const L = require("../dist/ledger.js");
const entry = (id,type,amountCents,extra={}) => ({id,type,amountCents,date:"2026-10-20",note:"Тест",createdAt:"2026-10-20T08:00:00.000Z",deleted:false,...extra});
test("Десятичные суммы точно переводятся в копейки",()=>{
  assert.equal(L.parseAmount("1 234,56"),123456);
  assert.equal(L.parseAmount("0.10"),10);
  assert.equal(L.parseAmount("0,20"),20);
  assert.equal(L.parseAmount("-50,25",true),-5025);
  for(const value of ["", "0", "-1", "1,001", "NaN", "Infinity", "1e3", "10.000.000", "10000000000"]) assert.throws(()=>L.parseAmount(value), value);
});
test("Остаток отделён от доходов; редактирование не создаёт дубль",()=>{
  let state = {...L.empty(),openingCents:1000000};
  state = L.upsert(state,entry("income","income",200000));
  state = L.upsert(state,entry("expense","expense",32050));
  assert.deepEqual(L.totals(state),{income:200000,expense:32050,balance:1167950});
  state = L.upsert(state,entry("expense","expense",50000));
  assert.equal(state.entries.length,2);
  assert.equal(L.totals(state).balance,1150000);
  state = L.upsert(state,entry("expense","income",50000));
  assert.deepEqual(L.totals(state),{income:250000,expense:0,balance:1250000});
});
test("Удаление исключает сумму, восстановление возвращает её ровно один раз",()=>{
  let state = L.upsert(L.empty(),entry("test","expense",100));
  state = L.setDeleted(state,"test",true);
  assert.equal(L.totals(state).balance,0);
  assert.equal(state.entries.length,1);
  state = L.setDeleted(state,"test",false);
  state = L.setDeleted(state,"test",false);
  assert.equal(L.totals(state).balance,-100);
});
test("Копия сохраняет копейки, остаток, даты, текст и удалённые записи",()=>{
  const state={...L.empty(),openingCents:-12345,entries:[entry("first","income",10),entry("second","expense",20,{deleted:true,note:"<script>это текст</script>"})]};
  assert.deepEqual(L.validate(JSON.parse(JSON.stringify(state))),state);
  const imported=L.merge(L.empty(),state);
  assert.equal(imported.added,2);
  assert.deepEqual(imported.state,state);
  assert.equal(L.merge(imported.state,state).added,0);
  assert.deepEqual(L.merge(imported.state,state).state,state);
});
test("Импорт объединяет записи и сохраняет существующий начальный остаток",()=>{
  const current={...L.empty(),openingCents:50000,entries:[entry("same","expense",500)]};
  const backup={...L.empty(),openingCents:999,entries:[entry("same","expense",999),entry("new","income",1000)]};
  const result=L.merge(current,backup);
  assert.equal(result.added,1);
  assert.equal(result.state.openingCents,50000);
  assert.equal(result.state.entries[0].amountCents,500);
});
test("Некорректные копии и невозможные даты не принимаются",()=>{
  assert.equal(L.validDate("2024-02-29"),true);
  assert.equal(L.validDate("2026-02-29"),false);
  assert.equal(L.validDate("2026-13-01"),false);
  assert.equal(L.validDate("2026-04-31"),false);
  for(const patch of [{amountCents:1.2},{amountCents:-1},{amountCents:0},{type:"transfer"},{date:"2026-02-30"},{deleted:"false"},{note:"x".repeat(161)},{createdAt:"bad"}]){
    assert.throws(()=>L.validate({...L.empty(),entries:[entry("a","income",10,patch)]}));
  }
  assert.throws(()=>L.validate({...L.empty(),entries:[entry("a","income",1),entry("a","expense",1)]}));
  assert.throws(()=>L.validate({version:2,openingCents:0,entries:[]}));
});
test("Сумма 0,10 и 0,20 даёт ровно 0,30",()=>{
  const state={...L.empty(),entries:[entry("one","income",L.parseAmount("0.10")),entry("two","income",L.parseAmount("0.20"))]};
  assert.equal(L.totals(state).balance,30);
});
