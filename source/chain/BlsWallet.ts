// Note: This code is mostly copied from
//   bls-wallet-aggregator/src/chain/BlsWallet.ts
// This might be a separate module in future. For now, any changes should be
// made there first, not here.

import {
  BlsWalletSigner,
  initBlsWalletSigner,
  TransactionData,
} from 'bls-wallet-signer';
import * as ethers from 'ethers';
import { BigNumber, Contract } from 'ethers';
import { keccak256 } from 'ethers/lib/utils';
import { VERIFICATION_GATEWAY_ADDRESS } from '../env';

import assert from '../helpers/assert';
import splitHex256 from '../helpers/splitHex256';
import BLSWallet from './ovmContractABIs/BLSWallet';
import VerificationGateway from './ovmContractABIs/VerificationGateway';

type SignerOrProvider = ethers.Signer | ethers.providers.Provider;

export default class BlsWallet {
  private constructor(
    public provider: ethers.providers.Provider,
    public network: ethers.providers.Network,
    public verificationGateway: Contract,
    public blsWalletSigner: BlsWalletSigner,
    public privateKey: string,
    public address: string,
    public walletContract: Contract,
  ) {}

  /** Checks whether the wallet contract has been created for this key. */
  static async Exists(
    privateKey: string,
    signerOrProvider: SignerOrProvider,
  ): Promise<boolean> {
    return (
      (await BlsWallet.Address(privateKey, signerOrProvider)) !== undefined
    );
  }

  /** Get the wallet contract address for the given key, if it exists. */
  static async Address(
    privateKey: string,
    signerOrProvider: SignerOrProvider,
    /**
     * Internal value associated with the bls-wallet-signer library that can be
     * provided as an optimization, otherwise it will be created
     * automatically.
     */
    blsWalletSigner?: BlsWalletSigner,
  ): Promise<string | undefined> {
    blsWalletSigner ??= await this.#BlsWalletSigner(signerOrProvider);
    const verificationGateway = this.#VerificationGateway(signerOrProvider);

    const address: string = await verificationGateway.walletFromHash(
      blsWalletSigner.getPublicKeyHash(privateKey),
    );

    if (address === ethers.constants.AddressZero) {
      return undefined;
    }

    return address;
  }

  /** Creates a special transaction used for the creation of a wallet. */
  static async signCreation(
    privateKey: string,
    signerOrProvider: SignerOrProvider,
  ): Promise<TransactionData> {
    const blsWalletSigner = await this.#BlsWalletSigner(signerOrProvider);
    const verificationGateway = this.#VerificationGateway(signerOrProvider);

    return blsWalletSigner.sign(
      {
        contractAddress: verificationGateway.address,
        encodedFunction: '0x',
        nonce: BigNumber.from(0),
        rewardTokenAddress: ethers.constants.AddressZero,
        rewardTokenAmount: BigNumber.from(0),
        ethValue: BigNumber.from(0),
      },
      privateKey,
    );
  }

  static async validateCreationTx(
    tx: TransactionData,
    signerOrProvider: SignerOrProvider,
  ): Promise<{ failures: string[] }> {
    const blsWalletSigner = await this.#BlsWalletSigner(signerOrProvider);

    const failures: string[] = [];

    if (!blsWalletSigner.verify(tx)) {
      failures.push('invalid signature');
    }

    if (tx.encodedFunction !== '0x') {
      failures.push('encoded function data mismatch');
    }

    return { failures };
  }

  /**
   * Instantiate a `BLSWallet` associated with the provided key.
   *
   * Creates the associated wallet contract if it doesn't exist yet, which is
   * why a parent wallet is required to create it.
   */
  static async connectOrCreate(
    privateKey: string,
    /** Wallet used to create the new wallet, if needed. */
    parent: ethers.Wallet,
  ): Promise<BlsWallet> {
    let wallet = await BlsWallet.connect(privateKey, parent.provider);

    if (wallet !== undefined) {
      return wallet;
    }

    const tx = await BlsWallet.signCreation(privateKey, parent);

    await (
      await this.#VerificationGateway(parent).actionCalls(
        ethers.constants.AddressZero,
        [splitHex256(tx.publicKey)],
        splitHex256(tx.signature),
        [
          {
            publicKeyHash: keccak256(tx.publicKey),
            nonce: tx.nonce,
            rewardTokenAddress: tx.rewardTokenAddress,
            rewardTokenAmount: tx.rewardTokenAmount,
            ethValue: tx.ethValue,
            contractAddress: tx.contractAddress,
            encodedFunction: tx.encodedFunction,
          },
        ],
      )
    ).wait();

    wallet = await BlsWallet.connect(privateKey, parent.provider);
    assert(wallet !== undefined);

    return wallet;
  }

  /**
   * Instantiate a `BLSWallet` associated with the provided key if the
   * associated wallet contract already exists.
   */
  static async connect(
    privateKey: string,
    provider: ethers.providers.Provider,
  ): Promise<BlsWallet | undefined> {
    const network = await provider.getNetwork();

    const blsWalletSigner = await initBlsWalletSigner({
      chainId: network.chainId,
    });

    const verificationGateway = this.#VerificationGateway(provider);

    const contractAddress = await BlsWallet.Address(privateKey, provider);

    if (contractAddress === undefined) {
      return undefined;
    }

    const walletContract = new ethers.Contract(
      contractAddress,
      BLSWallet.abi,
      provider,
    );

    return new BlsWallet(
      provider,
      network,
      verificationGateway,
      blsWalletSigner,
      privateKey,
      contractAddress,
      walletContract,
    );
  }

  /**
   * Get the next expected nonce for the wallet contract based on the latest
   * block.
   */
  async Nonce(): Promise<BigNumber> {
    return await this.walletContract.nonce();
  }

  static async Nonce(
    publicKey: string,
    signerOrProvider: SignerOrProvider,
  ): Promise<BigNumber> {
    const verificationGateway = await this.#VerificationGateway(
      signerOrProvider,
    );

    const publicKeyHash = keccak256(publicKey);
    const contractAddress = verificationGateway.walletFromHash(publicKeyHash);

    const walletContract = new ethers.Contract(
      contractAddress,
      BLSWallet.abi,
      signerOrProvider,
    );

    return walletContract.nonce();
  }

  /**
   * Sign a transaction, producing a `TransactionData` object suitable for use
   * with an aggregator.
   */
  sign({
    contract,
    method,
    args,
    rewardTokenAddress = ethers.constants.AddressZero,
    rewardTokenAmount = BigNumber.from(0),
    ethValue = BigNumber.from(0),
    nonce,
  }: {
    contract: ethers.Contract;
    method: string;
    args: string[];
    rewardTokenAddress?: string;
    rewardTokenAmount?: BigNumber;
    ethValue?: BigNumber;
    nonce: BigNumber;
  }): TransactionData {
    return this.blsWalletSigner.sign(
      {
        contractAddress: contract.address,
        encodedFunction: contract.interface.encodeFunctionData(method, args),
        nonce,
        rewardTokenAddress,
        rewardTokenAmount,
        ethValue,
      },
      this.privateKey,
    );
  }

  static #VerificationGateway(signerOrProvider: SignerOrProvider): Contract {
    return new Contract(
      VERIFICATION_GATEWAY_ADDRESS,
      VerificationGateway.abi,
      signerOrProvider,
    );
  }

  static async #BlsWalletSigner(
    signerOrProvider: SignerOrProvider,
  ): Promise<BlsWalletSigner> {
    const chainId =
      'getChainId' in signerOrProvider
        ? await signerOrProvider.getChainId()
        : (await signerOrProvider.getNetwork()).chainId;

    return await initBlsWalletSigner({ chainId });
  }
}
