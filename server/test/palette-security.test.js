'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const palette = require('../routes/palette');

describe('palette URL and address hardening', () => {
  it('allows only HTTPS cover CDN hostnames and rejects host tricks', () => {
    assert.equal(palette.isAllowedImageTarget('https://p1.music.126.net/cover.jpg'), true);
    assert.equal(palette.isAllowedImageTarget('https://img1.kuwo.cn/cover.jpg'), true);
    assert.equal(palette.isAllowedImageTarget('https://i0.hdslb.com/cover.jpg'), true);
    assert.equal(palette.isAllowedImageTarget('http://p1.music.126.net/cover.jpg'), false);
    assert.equal(palette.isAllowedImageTarget('https://p1.music.126.net.attacker.invalid/cover.jpg'), false);
    assert.equal(palette.isAllowedImageTarget('https://user@p1.music.126.net/cover.jpg'), false);
    assert.equal(palette.isAllowedImageTarget('https://127.0.0.1/cover.jpg'), false);
  });

  it('rejects IPv4, IPv6, mapped, link-local and reserved destinations', () => {
    for (const address of ['127.0.0.1','10.0.0.1','169.254.1.1','192.168.1.1','100.64.1.1','224.0.0.1','::','::1','fc00::1','fe80::1','ff02::1','::ffff:127.0.0.1','2001:db8::1']) {
      assert.equal(palette.isPublicAddress(address), false, address);
    }
    assert.equal(palette.isPublicAddress('8.8.8.8'), true);
    assert.equal(palette.isPublicAddress('2606:4700:4700::1111'), true);
  });

  it('checks JPEG dimensions before invoking the decoder', () => {
    const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x0b,0x08,0x00,0x02,0x00,0x03,0x01,0x01,0x11,0x00,0xff,0xd9]);
    assert.deepEqual(palette.jpegDimensions(jpeg), { width: 3, height: 2 });
    assert.doesNotThrow(() => palette.enforceDecodeLimit(jpeg, 'image/jpeg'));
    const huge = Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x0b,0x08,0x27,0x10,0x27,0x10,0x01,0x01,0x11,0x00,0xff,0xd9]);
    assert.throws(() => palette.enforceDecodeLimit(huge, 'image/jpeg'), /IMAGE_DIMENSION_LIMIT/);
  });
});
