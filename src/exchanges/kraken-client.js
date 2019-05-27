const { find } = require('underscore');
const BasicClient = require('../basic-client');
const zlib = require('zlib');
const winston = require('winston');
const Ticker = require('../ticker');
const Trade = require('../trade');
const Level2Point = require('../level2-point');
const Level2Snapshot = require('../level2-snapshot');
const Level2Update = require('../level2-update');
class KrakenClient extends BasicClient {
  constructor(params) {
    super('wss://ws.kraken.com', 'Kraken', params.consumer);
    this.consumer = params.consumer;
    this.hasTickers = true;
    this.hasTrades = true;
    this.hasLevel2Updates = true;
    // this.hasLevel2Snapshots = true;
    this.chanelIdToMarket = {};
  }
  _sendPong(ts) {
    if (this._wss) {
      this._wss.send(JSON.stringify({ pong: ts }));
    }
  }
  _sendSubTicker(remote_id) {
    this._wss.send(
      JSON.stringify({
        sub: `market.${remote_id}.detail`,
        id: remote_id,
      }),
    );
  }
  _sendUnsubTicker(remote_id) {
    this._wss.send(
      JSON.stringify({
        unsub: `market.${remote_id}.detail`,
        id: remote_id,
      }),
    );
  }
  _sendSubTrades(remote_id) {
    this._wss.send(
      JSON.stringify({
        sub: `market.${remote_id}.trade.detail`,
        id: remote_id,
      }),
    );
  }
  _sendUnsubTrades(remote_id) {
    this._wss.send(
      JSON.stringify({
        unsub: `market.${remote_id}.trade.detail`,
        id: remote_id,
      }),
    );
  }
  _sendSubLevel2Snapshots(remote_id) {
    this._wss.send(
      JSON.stringify({
        method: 'depth.subscribe',
        params: ['BTCBCH', 5, '0'],
        id: null,
      }),
    );
  }
  _sendUnsubLevel2Snapshots(remote_id) {
    this._wss.send(
      JSON.stringify({
        unsub: `market.${remote_id}.depth.step0`,
      }),
    );
  }
  _sendSubLevel2Updates(remote_ids) {
    this._wss.send(
      JSON.stringify({
        event: 'subscribe',
        pair: remote_ids,
        subscription: { name: 'book', depth: 100 },
      }),
    );
  }
  _sendUnsubLevel2Updates(remote_id) {
    this._wss.send(
      JSON.stringify({
        unsub: `market.${remote_id}.depth.step0`,
      }),
    );
  }
  _onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.error) {
      console.log(msg.error);
      return;
    }
    if (msg.event === 'subscriptionStatus') {
      this.chanelIdToMarket[msg.channelID] = msg.pair;
    } else if (!msg.event) {
      if (msg[1].b || msg[1].a) {
        let result = this._constructLevel2Update(msg);
        if (result) {
          this.emit('l2update');
          this.consumer.handleUpdate(result);
        }
      } else {
        let result = this._constructLevel2Snapshot(msg);
        if (result) {
          this.emit('l2snapshot');
          this.consumer.handleSnapshot(result);
        }
      }
      return;
    }
  }
  _constructTicker(remoteId, data) {
    let { open, close, high, low, vol, amount } = data;
    let market = this._tickerSubs.get(remoteId);
    let dayChange = close - open;
    let dayChangePercent = ((close - open) / open) * 100;
    return new Ticker({
      exchange: 'Huobi',
      base: market.base,
      quote: market.quote,
      timestamp: Date.now(),
      last: close,
      open: open,
      high: high,
      low: low,
      volume: amount,
      quoteVolume: vol,
      change: dayChange,
      changePercent: dayChangePercent,
    });
  }
  _constructTradesFromMessage(remoteId, datum) {
    let { amount, direction, ts, price, id } = datum;
    let market = this._tradeSubs.get(remoteId);
    let unix = Math.trunc(parseInt(ts));
    return new Trade({
      exchange: 'Huobi',
      base: market.base,
      quote: market.quote,
      tradeId: id,
      side: direction,
      unix,
      price,
      amount,
    });
  }
  _constructLevel2Snapshot(data) {
    const ask = data[1].as || [];
    const bid = data[1].bs || [];
    let pairName = this.chanelIdToMarket[data[0]].replace('XBT', 'BTC').replace('XDG', 'DOGE');
    let market = this._level2UpdateSubs.get(pairName);
    if (market) {
      let bids = bid.map(p => new Level2Point(p[0], p[1]));
      let asks = ask.map(p => new Level2Point(p[0], p[1]));
      return new Level2Snapshot({
        exchange: 'Kraken',
        base: market.base,
        quote: market.quote,
        asks,
        bids,
      });
    } else {
      console.log(`${pairName} market not found`);
    }
  }
  _constructLevel2Update(data) {
    let ask = data[1].a || [];
    let bid = data[2] ? data[2].b || []: data[1].b || [];
    ask = ask.sort((a, b) => (+a[2] > +b[2] ? 1 : -1)).reverse();
    bid = bid.sort((a, b) => (+a[2] > +b[2] ? 1 : -1)).reverse();
    const updatedAsk = [];
    const updatedBid = [];
    ask.forEach(currAsk => {
      const otherAsk = find(
        ask,
        currItem => currAsk[0] === currItem[0] && (currAsk[1] !== currItem[1] || currAsk[2] !== currItem[2]),
      );
      if (otherAsk) {
        const existingAsk = find(
          updatedAsk,
          currItem => currAsk[0] === currItem[0] && (currAsk[1] !== currItem[1] || currAsk[2] !== currItem[2]),
        );
        if (!existingAsk) {
          updatedAsk.push(currAsk);
        }
      } else {
        updatedAsk.push(currAsk);
      }
    });
    bid.forEach(currBid => {
      const otherBid = find(
        bid,
        currItem => currBid[0] === currItem[0] && (currBid[1] !== currItem[1] || currBid[2] !== currItem[2]),
      );
      if (otherBid) {
        const existingBid = find(
          updatedBid,
          currItem => currBid[0] === currItem[0] && (currBid[1] !== currItem[1] || currBid[2] !== currItem[2]),
        );
        if (!existingBid) {
          updatedBid.push(otherBid);
        }
      } else {
        updatedBid.push(currBid);
      }
    });
    // const iterator = updatedAsk.length > updatedBid.length ? updatedAsk : updatedBid;
    // const checker = updatedAsk.length > updatedBid.length ? updatedBid : updatedAsk;
    // const isAsk = updatedAsk.length > updatedBid.length;
    // iterator.forEach(item => {
    //   // if (find(iterator, currItem => item[0] === currItem[0] && (item[1] !== currItem[1] || item[2] !== currItem[2]))) {
    //   //   console.log('found the same item with diff ts');
    //   // }
    //   if (isAsk) {
    //     if (find(checker, currItem => item[0] >= currItem[0])) {
    //       console.log('found the same item with diff ts on the other array');
    //     }
    //   } else {
    //     if (find(checker, currItem => item[0] <= currItem[0])) {
    //       console.log('found the same item with diff ts on the other array');
    //     }
    //   }
    //
    //   // if (find(checker, currItem => item[0] === currItem[0])) {
    //   //   console.log('found the same item with diff ts on the other array');
    //   // }
    // });
    let pairName = this.chanelIdToMarket[data[0]].replace('XBT', 'BTC').replace('XDG', 'DOGE');
    let market = this._level2UpdateSubs.get(pairName);
    if (market) {
      let bids = updatedBid.map(p => new Level2Point(p[0], p[1]));
      let asks = updatedAsk.map(p => new Level2Point(p[0], p[1]));
      return new Level2Update({
        exchange: 'Kraken',
        base: market.base,
        quote: market.quote,
        asks,
        bids,
      });
    } else {
      console.log(`${pairName} market not found`);
    }
  }
}
module.exports = KrakenClient;
