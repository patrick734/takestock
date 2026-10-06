// Deploying before TOKEN exists: BuyBurn starts without a token, and `tokenSetter` sets it exactly once.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, baseFixture } = require("./fixtures");

describe("BuyBurn deployed before TOKEN", function () {
  async function pending() {
    const ctx = await baseFixture();
    const [, , , , , , setter] = await ethers.getSigners();
    const buyBurn = await ethers.deployContract("BuyBurnTakestock", [
      ethers.ZeroAddress,
      ctx.swap,
      ctx.admin.address,
      ctx.guardian.address,
      ctx.keeper.address,
      0,
      setter.address,
    ]);
    await buyBurn.connect(ctx.admin).setInputLimit(ctx.usdg, USDG(1_000));
    await ctx.usdg.mint(buyBurn, USDG(500)); // fees routed in before TOKEN exists
    return { ...ctx, buyBurn, setter };
  }

  describe("constructor", function () {
    it("needs either a token or a setter", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("BuyBurnTakestock");
      const base = [ctx.swap.target, ctx.admin.address, ctx.guardian.address, ctx.keeper.address, 0];
      await expect(F.deploy(ethers.ZeroAddress, ...base, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "InvalidConfig");
    });

    it("starts empty with the setter recorded", async function () {
      const { buyBurn, setter } = await loadFixture(pending);
      expect(await buyBurn.token()).to.equal(ethers.ZeroAddress);
      expect(await buyBurn.tokenSetter()).to.equal(setter.address);
    });

    it("ignores the setter when the token is fixed at deployment", async function () {
      const ctx = await loadFixture(baseFixture);
      const d = await ethers.deployContract("BuyBurnTakestock", [
        ctx.tok, ctx.swap, ctx.admin.address, ctx.guardian.address, ctx.keeper.address, 0, ctx.alice.address,
      ]);
      expect(await d.token()).to.equal(ctx.tok.target);
      expect(await d.tokenSetter()).to.equal(ethers.ZeroAddress);
      await expect(d.connect(ctx.alice).setToken(ctx.usdg)).to.be.revertedWithCustomError(d, "Unauthorized");
    });
  });

  describe("before the token is set", function () {
    it("holds fees and refuses to draw down", async function () {
      const { buyBurn, keeper, usdg } = await loadFixture(pending);
      await expect(buyBurn.connect(keeper).buyAndBurn(usdg, USDG(100), 1n, "0x")).to.be.revertedWithCustomError(buyBurn, "TokenNotSet");
      expect(await usdg.balanceOf(buyBurn)).to.equal(USDG(500));
    });

    it("treats burnHeld as a no-op", async function () {
      const { buyBurn } = await loadFixture(pending);
      await expect(buyBurn.burnHeld()).to.not.be.reverted;
      expect(await buyBurn.totalBurned()).to.equal(0n);
    });
  });

  describe("setToken", function () {
    it("only the setter can call it", async function () {
      const { buyBurn, admin, alice, tok } = await loadFixture(pending);
      await expect(buyBurn.connect(alice).setToken(tok)).to.be.revertedWithCustomError(buyBurn, "Unauthorized");
      // Not even the admin: the setter is the only key with this power.
      await expect(buyBurn.connect(admin).setToken(tok)).to.be.revertedWithCustomError(buyBurn, "Unauthorized");
    });

    it("rejects the zero address", async function () {
      const { buyBurn, setter } = await loadFixture(pending);
      await expect(buyBurn.connect(setter).setToken(ethers.ZeroAddress)).to.be.revertedWithCustomError(buyBurn, "InvalidConfig");
    });

    it("sets the token once and can never change it", async function () {
      const { buyBurn, setter, tok, usdg } = await loadFixture(pending);
      await expect(buyBurn.connect(setter).setToken(tok)).to.emit(buyBurn, "TokenSet").withArgs(tok.target);
      expect(await buyBurn.token()).to.equal(tok.target);
      await expect(buyBurn.connect(setter).setToken(usdg)).to.be.revertedWithCustomError(buyBurn, "TokenAlreadySet");
      await expect(buyBurn.connect(setter).setToken(tok)).to.be.revertedWithCustomError(buyBurn, "TokenAlreadySet");
    });

    it("then spends the fees that waited and burns the TOKEN", async function () {
      const { buyBurn, setter, keeper, tok, usdg } = await loadFixture(pending);
      await buyBurn.connect(setter).setToken(tok);
      const supply = await tok.totalSupply();
      await expect(buyBurn.connect(keeper).buyAndBurn(usdg, USDG(500), 1n, "0x")).to.emit(buyBurn, "Burned");
      const retired = await buyBurn.totalBurned();
      expect(retired).to.be.gt(0n);
      expect(await tok.totalSupply()).to.equal(supply - retired);
      expect(await usdg.balanceOf(buyBurn)).to.equal(0n);
    });
  });
});
