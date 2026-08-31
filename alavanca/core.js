(function(root, factory){
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlavancaCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const VERSION = '3.2.0';
  const MAX_MONEY = 1e12;
  const DEFAULT_SETTINGS = Object.freeze({
    initialBankroll: 100,
    targetBankroll: 500,
    plannedEntries: 30,
    maxExposure: 5
  });

  const round2 = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
  const floor2 = v => Math.floor((Math.max(0, Number(v)) + 1e-9) * 100) / 100;
  const ceil2 = v => Math.ceil((Math.max(0, Number(v)) - 1e-9) * 100) / 100;
  const asNum = (v, fallback=0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const clamp = (v,min,max) => Math.min(max,Math.max(min,v));

  function normalizeSettings(s={}) {
    const initialBankroll = clamp(asNum(s.initialBankroll, DEFAULT_SETTINGS.initialBankroll), 0.01, MAX_MONEY);
    const targetBankroll = clamp(asNum(s.targetBankroll, DEFAULT_SETTINGS.targetBankroll), 0.01, MAX_MONEY);
    const plannedEntries = clamp(Math.floor(asNum(s.plannedEntries, DEFAULT_SETTINGS.plannedEntries)), 1, 1000);
    const maxExposure = clamp(asNum(s.maxExposure, DEFAULT_SETTINGS.maxExposure), 0.1, 100);
    return {
      initialBankroll: round2(initialBankroll),
      targetBankroll: round2(targetBankroll),
      plannedEntries,
      maxExposure: Math.round(maxExposure * 10) / 10
    };
  }

  function isSettledBet(x){
    return !!(x && x.type === 'bet' && (x.result === 'green' || x.result === 'red' || x.result === 'manual'));
  }
  function isBet(x){ return !!(x && x.type === 'bet'); }

  function rebuildLedger(settings, ledger){
    const s = normalizeSettings(settings);
    let bank = s.initialBankroll;
    const rebuilt = (Array.isArray(ledger) ? ledger : []).map(item => {
      const x = { ...item };
      x.bankBefore = bank;
      let delta = 0;
      if (x.type === 'adjustment') {
        x.amount = round2(asNum(x.amount, 0));
        delta = x.amount;
      } else if (x.type === 'bet') {
        x.pnl = round2(asNum(x.pnl, 0));
        delta = x.pnl;
        x.stake = Math.max(0, round2(asNum(x.stake, 0)));
        x.odd = round2(asNum(x.odd, 0));
        x.exposurePct = bank > 0 ? x.stake / bank * 100 : 0;
      }
      bank = round2(Math.max(0, bank + delta));
      x.bankAfter = bank;
      return x;
    });
    return { ledger: rebuilt, bank };
  }

  function currentBankroll(settings, ledger){ return rebuildLedger(settings, ledger).bank; }
  function completedEntries(ledger){ return (Array.isArray(ledger) ? ledger : []).filter(isSettledBet).length; }
  function remainingEntries(settings, ledger){
    const s = normalizeSettings(settings);
    return Math.max(0, s.plannedEntries - completedEntries(ledger));
  }

  function computePlan(settings, ledger, odd){
    const s = normalizeSettings(settings);
    const bank = currentBankroll(s, ledger);
    const rem = remainingEntries(s, ledger);
    const oRaw = asNum(odd, NaN);
    if (!(oRaw > 1) || !Number.isFinite(oRaw) || !(bank > 0)) return null;
    const o = round2(oRaw);
    if (!(o > 1)) return null;

    const exposureLimit = floor2(Math.min(bank, bank * s.maxExposure / 100));

    if (bank >= s.targetBankroll) {
      return {
        bank, remaining: rem, factor: 1, nextTarget: bank, profitNeeded: 0,
        rawStake: 0, requiredStake: 0, suggestedStake: 0, exposureLimit,
        exposurePct: 0, projectedBank: bank, projectedProfit: 0, minOdd: 1.01,
        limited: false, status: 'target_reached'
      };
    }

    if (rem <= 0) {
      return {
        bank, remaining: 0, factor: 1, nextTarget: bank, profitNeeded: 0,
        rawStake: 0, requiredStake: 0, suggestedStake: 0, exposureLimit,
        exposurePct: 0, projectedBank: bank, projectedProfit: 0, minOdd: Infinity,
        limited: false, status: 'no_entries'
      };
    }

    if (exposureLimit < 0.01) {
      return {
        bank, remaining: rem, factor: 1, nextTarget: bank, profitNeeded: 0,
        rawStake: 0, requiredStake: 0, suggestedStake: 0, exposureLimit,
        exposurePct: 0, projectedBank: bank, projectedProfit: 0, minOdd: Infinity,
        limited: true, status: 'below_minimum_stake'
      };
    }

    const ratio = s.targetBankroll / bank;
    const factor = Math.exp(Math.log(ratio) / rem);
    let nextTarget = round2(bank * factor);
    nextTarget = Math.min(s.targetBankroll, Math.max(round2(bank + 0.01), nextTarget));
    const profitNeeded = Math.max(0.01, round2(nextTarget - bank));

    const rawStake = profitNeeded / (o - 1);
    const requiredStake = ceil2(rawStake);
    const suggestedStake = Math.min(requiredStake, exposureLimit, bank);
    const exposurePct = bank > 0 ? suggestedStake / bank * 100 : 0;
    const projectedProfit = round2(suggestedStake * (o - 1));
    const projectedBank = round2(bank + projectedProfit);
    const minOdd = exposureLimit > 0 ? ceil2(1 + profitNeeded / exposureLimit) : Infinity;
    const limited = requiredStake > exposureLimit + 0.0001;

    return {
      bank, remaining: rem, factor, nextTarget, profitNeeded, rawStake, requiredStake,
      suggestedStake, exposureLimit, exposurePct, projectedBank, projectedProfit,
      minOdd, limited, status: limited ? 'limited' : 'ok'
    };
  }

  function makeBet(settings, ledger, { odd, stake, result, manualPnl=0, label='', timestamp=null, id=null }){
    const s = normalizeSettings(settings);
    const rebuilt = rebuildLedger(s, ledger);
    const bankBefore = rebuilt.bank;
    const o = asNum(odd, NaN);
    const st = round2(asNum(stake, NaN));
    if (!(o > 1) || !Number.isFinite(o)) throw new Error('Odd inválida.');
    const roundedOdd = round2(o);
    if (!(roundedOdd > 1)) throw new Error('Odd inválida.');
    if (!(st >= 0.01)) throw new Error('A stake mínima é R$ 0,01.');
    if (st > bankBefore + 0.005) throw new Error('Stake maior que a banca.');
    const maxAllowed = floor2(bankBefore * s.maxExposure / 100);
    if (st > maxAllowed + 0.0001) throw new Error('Stake acima do limite de exposição.');
    if (!['green','red','void','manual'].includes(result)) throw new Error('Resultado inválido.');

    let pnl = 0;
    if (result === 'green') pnl = round2(st * (roundedOdd - 1));
    else if (result === 'red') pnl = -st;
    else if (result === 'manual') {
      pnl = round2(asNum(manualPnl, 0));
      if (pnl < -st - 0.005) throw new Error('Prejuízo manual maior que a stake.');
    }

    const item = {
      id: id || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      type: 'bet',
      timestamp: timestamp || new Date().toISOString(),
      odd: roundedOdd, stake: st, result, pnl,
      label: String(label || '').trim().slice(0, 80),
      maxExposureAtEntry: s.maxExposure
    };
    const out = rebuildLedger(s, [...rebuilt.ledger, item]);
    return { item: out.ledger[out.ledger.length - 1], ledger: out.ledger, bank: out.bank };
  }

  function makeAdjustment(settings, ledger, amount, reason='', timestamp=null, id=null){
    const s = normalizeSettings(settings);
    const rebuilt = rebuildLedger(s, ledger);
    const amt = round2(asNum(amount, NaN));
    if (!Number.isFinite(amt) || Math.abs(amt) < 0.005) throw new Error('Valor de ajuste inválido.');
    if (rebuilt.bank + amt < -0.005) throw new Error('A retirada não pode deixar a banca negativa.');
    const item = {
      id: id || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      type:'adjustment', timestamp: timestamp || new Date().toISOString(),
      amount: amt, reason: String(reason || '').trim().slice(0, 80)
    };
    const out = rebuildLedger(s, [...rebuilt.ledger, item]);
    return { item: out.ledger[out.ledger.length - 1], ledger: out.ledger, bank: out.bank };
  }

  function stats(settings, ledger){
    const s = normalizeSettings(settings);
    const rebuilt = rebuildLedger(s, ledger);
    const bs = rebuilt.ledger.filter(isBet);
    const settled = bs.filter(isSettledBet);
    const greens = settled.filter(x => Number(x.pnl) > 0).length;
    const reds = settled.filter(x => Number(x.pnl) < 0).length;
    const voids = bs.filter(x => x.result === 'void').length;
    const manualFlat = settled.filter(x => Math.abs(Number(x.pnl)||0) < 0.0001).length;
    const wins = settled.filter(x => Number(x.pnl) > 0).reduce((a,x)=>a+Number(x.pnl),0);
    const losses = Math.abs(settled.filter(x => Number(x.pnl) < 0).reduce((a,x)=>a+Number(x.pnl),0));
    const adjustments = rebuilt.ledger.filter(x=>x.type==='adjustment').reduce((a,x)=>a+asNum(x.amount,0),0);
    const pnl = round2(rebuilt.bank - s.initialBankroll - adjustments);
    const roi = s.initialBankroll > 0 ? pnl / s.initialBankroll * 100 : 0;
    const hitRate = (greens + reds) > 0 ? greens / (greens + reds) * 100 : 0;

    // External deposits/withdrawals should not create an artificial drawdown.
    let equity = s.initialBankroll, peak = s.initialBankroll, maxDD = 0;
    rebuilt.ledger.forEach(x=>{
      if (x.type === 'adjustment') {
        const amount = asNum(x.amount,0);
        equity = round2(Math.max(0, equity + amount));
        peak = Math.max(equity, round2(Math.max(0, peak + amount)));
        return;
      }
      equity = round2(Math.max(0, equity + asNum(x.pnl,0)));
      peak = Math.max(peak, equity);
      if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak * 100);
    });

    const totalStaked = round2(bs.reduce((a,x)=>a+asNum(x.stake,0),0));
    const avgOddList = bs.filter(x=>asNum(x.odd,0)>1).map(x=>asNum(x.odd,0));
    const avgOdd = avgOddList.length ? avgOddList.reduce((a,b)=>a+b,0)/avgOddList.length : 0;
    const profitFactor = losses > 0 ? wins/losses : wins > 0 ? Infinity : 0;

    return {
      bank: rebuilt.bank, pnl, roi, greens, reds, voids, manualFlat,
      completed: completedEntries(rebuilt.ledger), remaining: remainingEntries(s, rebuilt.ledger),
      hitRate, maxDD, peak, totalStaked, avgOdd, profitFactor,
      progress: s.targetBankroll > s.initialBankroll
        ? Math.max(0, Math.min(100, (rebuilt.bank - s.initialBankroll)/(s.targetBankroll-s.initialBankroll)*100))
        : (rebuilt.bank >= s.targetBankroll ? 100 : 0)
    };
  }

  function audit(settings, ledger){
    const s = normalizeSettings(settings);
    const list = Array.isArray(ledger) ? ledger : [];
    const issues=[];
    const ids=new Set();
    let bank=s.initialBankroll;

    list.forEach((x,i)=>{
      const n=i+1;
      if(!x || typeof x !== 'object'){issues.push(`Registro ${n}: formato inválido`);return;}
      if(!x.id) issues.push(`Registro ${n}: ID ausente`);
      else if(ids.has(x.id)) issues.push(`Registro ${n}: ID duplicado`);
      else ids.add(x.id);
      if(!Number.isFinite(new Date(x.timestamp).getTime())) issues.push(`Registro ${n}: data inválida`);
      if(Number.isFinite(Number(x.bankBefore)) && Math.abs(Number(x.bankBefore)-bank)>0.01) issues.push(`Registro ${n}: banca anterior inconsistente`);

      let delta=0;
      if(x.type==='bet'){
        const odd=asNum(x.odd,0), stake=asNum(x.stake,-1), pnl=asNum(x.pnl,NaN);
        if(!(odd>1)) issues.push(`Registro ${n}: odd inválida`);
        if(!(stake>=0.01)) issues.push(`Registro ${n}: stake inválida`);
        if(stake>bank+0.01) issues.push(`Registro ${n}: stake maior que a banca anterior`);
        const expAtEntry = clamp(asNum(x.maxExposureAtEntry, s.maxExposure),0.1,100);
        const limitAtEntry = floor2(bank * expAtEntry / 100);
        if(stake>limitAtEntry+0.0001) issues.push(`Registro ${n}: stake acima do limite da entrada`);
        if(!['green','red','void','manual'].includes(x.result)) issues.push(`Registro ${n}: resultado inválido`);
        if(!Number.isFinite(pnl)) issues.push(`Registro ${n}: P/L inválido`);
        if(x.result==='green' && Number.isFinite(pnl) && Math.abs(pnl-round2(stake*(odd-1)))>0.01) issues.push(`Registro ${n}: P/L de GREEN inconsistente`);
        if(x.result==='red' && Number.isFinite(pnl) && Math.abs(pnl+stake)>0.01) issues.push(`Registro ${n}: P/L de RED inconsistente`);
        if(x.result==='void' && Number.isFinite(pnl) && Math.abs(pnl)>0.01) issues.push(`Registro ${n}: P/L de ANULADA inconsistente`);
        if(x.result==='manual' && Number.isFinite(pnl) && pnl < -stake - 0.01) issues.push(`Registro ${n}: prejuízo manual maior que a stake`);
        delta=Number.isFinite(pnl)?pnl:0;
      } else if(x.type==='adjustment'){
        const amount=asNum(x.amount,NaN);
        if(!Number.isFinite(amount)) issues.push(`Registro ${n}: ajuste inválido`);
        if(Number.isFinite(amount) && bank+amount < -0.005) issues.push(`Registro ${n}: ajuste deixaria a banca negativa`);
        delta=Number.isFinite(amount)?amount:0;
      } else {
        issues.push(`Registro ${n}: tipo desconhecido`);
      }

      const nextBank=round2(Math.max(0,bank+delta));
      if(Number.isFinite(Number(x.bankAfter)) && Math.abs(Number(x.bankAfter)-nextBank)>0.01) issues.push(`Registro ${n}: banca posterior inconsistente`);
      bank=nextBank;
    });

    const rebuilt=rebuildLedger(s,list);
    if(Math.abs(rebuilt.bank-bank)>0.01) issues.push('Saldo final inconsistente após reconstrução');
    return { ok:issues.length===0, issues, records:list.length, bank:rebuilt.bank };
  }

  return {
    VERSION, DEFAULT_SETTINGS, MAX_MONEY, round2, floor2, ceil2, normalizeSettings, rebuildLedger,
    currentBankroll, completedEntries, remainingEntries, computePlan, makeBet, makeAdjustment,
    stats, audit, isSettledBet, isBet
  };
});
