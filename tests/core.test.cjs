const {test} = require("node:test");
const assert = require("node:assert/strict");
const M = require("../dist/core/money.js");
const S = require("../dist/core/schema.js");
const J = require("../dist/core/journal.js");
const V = require("../dist/core/views.js");
const TODAY = "2026-10-20", NOW = "2026-10-21T09:00:00.000Z";
const op = (id,type,amount,extra={}) => ({id,type,date:"2026-10-20",note:"Тест",createdAt:"2026-10-20T08:00:00.000Z",updatedAt:"2026-10-20T08:00:00.000Z",deleted:false,
  legs:[{accountId:"main",amountCents:type==="income"?amount:-amount}],allocations:type==="income"?[]:[{categoryId:null,amountCents:amount}],links:{},revisions:[],...extra});
const v1entry = (id,type,amountCents,extra={}) => ({id,type,amountCents,date:"2026-10-20",note:"Тест",createdAt:"2026-10-20T08:00:00.000Z",deleted:false,...extra});
const base = (opening=0) => { const s = S.empty(TODAY); s.accounts[0].openingCents = opening; return s; };
const add = (state,o) => J.upsertOperation(state,o,NOW);
test("Десятичные суммы точно переводятся в копейки",()=>{
  assert.equal(M.parseAmount("1 234,56"),123456);
  assert.equal(M.parseAmount("0.10"),10);
  assert.equal(M.parseAmount("0,20"),20);
  assert.equal(M.parseAmount("-50,25",true),-5025);
  for(const value of ["", "0", "-1", "1,001", "NaN", "Infinity", "1e3", "10.000.000", "10000000000"]) assert.throws(()=>M.parseAmount(value), value);
});
test("Остаток отделён от доходов; редактирование не создаёт дубль",()=>{
  let state = base(1000000);
  state = add(state,op("income","income",200000));
  state = add(state,op("expense","expense",32050));
  assert.deepEqual(V.totals(state),{income:200000,expense:32050,balance:1167950});
  state = add(state,op("expense","expense",50000));
  assert.equal(state.operations.length,2);
  assert.equal(V.totals(state).balance,1150000);
  state = add(state,op("expense","income",50000));
  assert.deepEqual(V.totals(state),{income:250000,expense:0,balance:1250000});
});
test("Удаление исключает сумму, восстановление возвращает её ровно один раз",()=>{
  let state = add(S.empty(TODAY),op("test","expense",100));
  state = J.setDeleted(state,"test",true);
  assert.equal(V.totals(state).balance,0);
  assert.equal(state.operations.length,1);
  state = J.setDeleted(state,"test",false);
  state = J.setDeleted(state,"test",false);
  assert.equal(V.totals(state).balance,-100);
  assert.equal(state.operations[0].revisions.length,0);
  assert.throws(()=>J.setDeleted(state,"nope",true),/Запись не найдена/);
});
test("Копия сохраняет копейки, остаток, даты, текст и удалённые записи",()=>{
  let state=base(-12345);
  state=add(state,op("first","income",10));
  state=add(state,op("second","expense",20,{deleted:true,note:"<script>это текст</script>"}));
  assert.deepEqual(S.validate(JSON.parse(JSON.stringify(state))),state);
  const imported=J.merge(S.empty(TODAY),state,TODAY);
  assert.equal(imported.added,2);
  assert.deepEqual(imported.state,state);
  assert.equal(J.merge(imported.state,state,TODAY).added,0);
  assert.deepEqual(J.merge(imported.state,state,TODAY).state,state);
});
test("Импорт объединяет записи и сохраняет существующий начальный остаток",()=>{
  const current=add(base(50000),op("same","expense",500));
  const backup=add(add(base(999),op("same","expense",999)),op("new","income",1000));
  const result=J.merge(current,backup,TODAY);
  assert.equal(result.added,1);
  assert.equal(result.state.accounts[0].openingCents,50000);
  assert.equal(V.totals(result.state).balance,50000-500+1000);
  assert.equal(result.state.operations[0].legs[0].amountCents,-500);
});
test("Импорт добавляет новые счета",()=>{
  const other=base();other.accounts.push({id:"cash",name:"Наличные",kind:"cash",openingCents:500,openingDate:TODAY,archived:false});
  const result=J.merge(base(),other,TODAY);
  assert.deepEqual(result.state.accounts.map(a=>a.id),["main","cash"]);
  assert.deepEqual(V.balances(result.state),{byAccount:{main:0,cash:500},total:500});
});
test("Некорректные копии и невозможные даты не принимаются",()=>{
  assert.equal(M.validDate("2024-02-29"),true);
  assert.equal(M.validDate("2026-02-29"),false);
  assert.equal(M.validDate("2026-13-01"),false);
  assert.equal(M.validDate("2026-04-31"),false);
  const patches=[{legs:[{accountId:"main",amountCents:1.2}]},{legs:[{accountId:"main",amountCents:0}]},{type:"transfer"},{date:"2026-02-30"},{deleted:"false"},{note:"x".repeat(161)},{createdAt:"bad"},{updatedAt:"bad"},{revisions:"x"},{id:"плохой id"}];
  for(const patch of patches) assert.throws(()=>S.validate({...base(),operations:[op("a","income",10,patch)]}),JSON.stringify(patch));
  assert.throws(()=>S.validate({...base(),operations:[op("a","income",1),op("a","expense",1)]}));
  assert.throws(()=>S.validate({version:1,openingCents:0,entries:[]}));
});
test("Сумма 0,10 и 0,20 даёт ровно 0,30",()=>{
  const state={...base(),operations:[op("one","income",M.parseAmount("0.10")),op("two","income",M.parseAmount("0.20"))]};
  assert.equal(V.totals(S.validate(state)).balance,30);
});
test("Миграция v1 → v2 переносит остаток, суммы и удалённые записи",()=>{
  const v1={version:1,openingCents:1000000,entries:[v1entry("i","income",200000,{date:"2026-10-05"}),v1entry("e","expense",32050),v1entry("d","expense",777,{deleted:true})]};
  const state=S.migrate(v1,TODAY);
  assert.equal(state.version,2);
  assert.deepEqual(V.totals(state),{income:200000,expense:32050,balance:1167950});
  assert.equal(state.accounts[0].openingDate,"2026-10-05");
  assert.equal(state.operations.find(o=>o.id==="d").deleted,true);
  assert.deepEqual(state.operations.find(o=>o.id==="e").allocations,[{categoryId:null,amountCents:32050}]);
  assert.equal(state.operations[0].updatedAt,state.operations[0].createdAt);
  assert.equal(S.migrate({version:1,openingCents:0,entries:[]},TODAY).accounts[0].openingDate,TODAY);
});
test("Повторная миграция v2 ничего не меняет",()=>{
  const state=S.migrate({version:1,openingCents:5,entries:[v1entry("i","income",100),v1entry("e","expense",50)]},TODAY);
  assert.deepEqual(S.migrate(state,"2030-01-01"),state);
  assert.deepEqual(S.migrate(JSON.parse(JSON.stringify(state)),TODAY),state);
});
test("Правка создаёт ровно одну ревизию; без изменений ревизии нет; максимум 20",()=>{
  let state=add(base(),op("x","expense",100));
  const same=J.upsertOperation(state,op("x","expense",100),"2026-10-22T00:00:00.000Z");
  assert.equal(same,state);
  const edited=J.upsertOperation(state,op("x","expense",250),"2026-10-22T00:00:00.000Z");
  const saved=edited.operations[0];
  assert.equal(saved.revisions.length,1);
  assert.equal(saved.revisions[0].before.legs[0].amountCents,-100);
  assert.equal(saved.revisions[0].at,"2026-10-22T00:00:00.000Z");
  assert.equal(saved.createdAt,"2026-10-20T08:00:00.000Z");
  assert.equal(saved.updatedAt,"2026-10-22T00:00:00.000Z");
  assert.equal(J.upsertOperation(edited,op("x","expense",250),NOW),edited);
  for(let i=1;i<=25;i++) state=J.upsertOperation(state,op("x","expense",100+i),NOW);
  assert.equal(state.operations[0].revisions.length,20);
  assert.equal(state.operations[0].revisions[19].before.legs[0].amountCents,-124);
});
test("Валидация отвергает невозможные операции и версии",()=>{
  const bad=o=>assert.throws(()=>S.validate({...base(),operations:[o]}));
  bad(op("a","expense",10,{legs:[{accountId:"main",amountCents:10}]}));
  bad(op("a","income",10,{legs:[{accountId:"main",amountCents:-10}]}));
  bad(op("a","income",10,{legs:[{accountId:"nope",amountCents:10}]}));
  bad(op("a","expense",10,{allocations:[{categoryId:null,amountCents:9}]}));
  bad(op("a","income",10,{allocations:[{categoryId:null,amountCents:10}]}));
  bad(op("a","transfer",10));
  assert.doesNotThrow(()=>S.validate({...base(),operations:[op("a","expense",10,{allocations:[]})]}));
  assert.doesNotThrow(()=>S.validate({...base(),operations:[op("a","expense",10,{allocations:[{categoryId:"c1",amountCents:4},{categoryId:null,amountCents:6}]})]}));
  assert.throws(()=>S.validate({...base(),version:3}),/Не удалось прочитать копию money\.log/);
  assert.throws(()=>S.migrate({version:3},TODAY),/Не удалось прочитать копию money\.log/);
});
test("Слияние v1-копии в пустой журнал даёт тот же результат, что миграция",()=>{
  const v1={version:1,openingCents:-12345,entries:[v1entry("a","income",10,{date:"2026-09-01"}),v1entry("b","expense",20,{deleted:true})]};
  const merged=J.merge(S.empty(TODAY),v1,TODAY);
  assert.equal(merged.added,2);
  assert.deepEqual(merged.state,S.migrate(v1,TODAY));
});
test("setOpening меняет остаток счёта; неизвестный счёт — ошибка",()=>{
  const state=J.setOpening(add(base(),op("a","income",100)),"main",-500);
  assert.equal(V.balances(state).total,-400);
  assert.throws(()=>J.setOpening(state,"nope",1));
});
test("Займы и люди не входят в общий баланс",()=>{
  const state=base(100);
  state.accounts.push({id:"l",name:"Долг",kind:"loan",openingCents:-9000,openingDate:TODAY,archived:false});
  assert.deepEqual(V.balances(S.validate(state)),{byAccount:{main:100,l:-9000},total:100});
});
