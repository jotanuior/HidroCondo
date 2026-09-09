import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReading, parseCounter } from '../src/reading-policy.ts';

const base={previous:5000,current:5010,digits:6,factor:0.001,elapsedSeconds:60,
  sourceTime:null,previousSourceTime:null,receivedTime:1000000,maxFlowM3Hour:null,pending:false};
test('consumo normal e contador parado',()=>{
  assert.equal(evaluateReading(base).delta,10);
  assert.equal(evaluateReading({...base,current:5000}).delta,0);
});
test('redução não vira quase um milhão de incrementos',()=>{
  assert.deepEqual(evaluateReading({...base,current:4990}),{accepted:false,delta:0,status:'suspect_decrease'});
});
test('volta de seis e três dígitos exige limite físico e intervalo plausível',()=>{
  assert.equal(evaluateReading({...base,previous:999999,current:0,maxFlowM3Hour:1}).delta,1);
  assert.equal(evaluateReading({...base,previous:999,current:2,digits:3,maxFlowM3Hour:1}).delta,3);
  assert.equal(evaluateReading({...base,current:4990,maxFlowM3Hour:1}).status,'suspect_flow');
});
test('intervalo que permite várias voltas fica pendente',()=>{
  assert.equal(evaluateReading({...base,previous:999,current:1,digits:3,maxFlowM3Hour:100,elapsedSeconds:86400}).status,'ambiguous_rollover');
});
test('mensagens antigas ou futuras não mudam o contador',()=>{
  assert.equal(evaluateReading({...base,sourceTime:100,previousSourceTime:200}).status,'out_of_order');
  assert.equal(evaluateReading({...base,sourceTime:10000000}).status,'future_timestamp');
});
test('pendência bloqueia também incrementos posteriores até conferência',()=>{
  assert.equal(evaluateReading({...base,pending:true}).status,'pending_review');
});
test('primeira leitura estabelece a referência, sem cobrar o acumulado',()=>{
  assert.equal(evaluateReading({...base,previous:null}).delta,0);
});
test('protocolo inválido e leitura parcialmente numérica são rejeitados',()=>{
  for(const value of ['123abc','12.5','','-1','1e3',1000000,NaN]) assert.throws(()=>parseCounter(value));
  assert.equal(parseCounter('000009'),9);
  assert.equal(evaluateReading({...base,current:1000,digits:3}).status,'counter_out_of_range');
});
