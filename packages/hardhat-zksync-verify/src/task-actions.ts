import { DependencyGraph, HardhatRuntimeEnvironment, RunSuperFunction, TaskArguments } from 'hardhat/types';

import { getSupportedCompilerVersions, verifyContractRequest } from './zksync-block-explorer/service';

import {
    TASK_COMPILE,
    TASK_VERIFY_GET_CONSTRUCTOR_ARGUMENTS,
    TASK_VERIFY_GET_LIBRARIES,
    TASK_VERIFY_VERIFY,
    TESTNET_VERIFY_URL,
    NO_VERIFIABLE_ADDRESS_ERROR,
    CONST_ARGS_ARRAY_ERROR,
    TASK_VERIFY_GET_MINIMUM_BUILD,
    TASK_VERIFY_GET_COMPILER_VERSIONS,
    TASK_VERIFY_GET_CONTRACT_INFORMATION,
    TASK_VERIFY_VERIFY_MINIMUM_BUILD,
    NO_MATCHING_CONTRACT,
    COMPILER_VERSION_NOT_SUPPORTED,
    TASK_CHECK_VERIFICATION_STATUS,
    JSON_INPUT_CODE_FORMAT,
    UNSUCCESSFUL_VERIFICATION_MESSAGE,
    UNSUCCESSFUL_VERIFICATION_ID,
} from './constants';

import {
    encodeArguments,
    executeVeificationWithRetry,
    removeMultipleSubstringOccurrences,
    retrieveContractBytecode,
} from './utils';
import { Build, Libraries } from './types';
import { ZkSyncBlockExplorerVerifyRequest } from './zksync-block-explorer/verify-contract-request';
import { ZkSyncVerifyPluginError } from './errors';
import { parseFullyQualifiedName } from 'hardhat/utils/contract-names';
import chalk from 'chalk';

import { Bytecode, extractMatchingContractInformation } from './solc/bytecode';

import { ContractInformation } from './solc/types';
import { checkContractName, flattenContractFile, getSolidityStandardJsonInput, inferContractArtifacts } from './plugin';
import { TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH } from 'hardhat/builtin-tasks/task-names';

export async function verify(
    args: {
        address: string;
        constructorArgs: string;
        contract: string;
        constructorArgsParams: any[];
        librariesModule: string;
    },
    hre: HardhatRuntimeEnvironment,
    runSuper: RunSuperFunction<TaskArguments>
) {
    if (!hre.network.zksync) {
        return await runSuper(args);
    }

    if (hre.network.verifyURL === undefined) {
        hre.network.verifyURL = TESTNET_VERIFY_URL;
    }

    if (args.address === undefined) {
        throw new ZkSyncVerifyPluginError(NO_VERIFIABLE_ADDRESS_ERROR);
    }

    const constructorArguments: any[] = await hre.run(TASK_VERIFY_GET_CONSTRUCTOR_ARGUMENTS, {
        constructorArgsModule: args.constructorArgs,
        constructorArgsParams: args.constructorArgsParams,
    });

    const libraries: Libraries = await hre.run(TASK_VERIFY_GET_LIBRARIES, {
        librariesModule: args.librariesModule,
    });

    const verificationId = await hre.run(TASK_VERIFY_VERIFY, {
        address: args.address,
        constructorArguments: constructorArguments,
        contract: args.contract,
        libraries,
    });

    if (verificationId === UNSUCCESSFUL_VERIFICATION_ID) {
        console.log(chalk.red(UNSUCCESSFUL_VERIFICATION_MESSAGE(hre.network.name, args.address)));
    }
}

export async function getCompilerVersions(
    _: TaskArguments,
    hre: HardhatRuntimeEnvironment,
    runSuper: RunSuperFunction<TaskArguments>
): Promise<string[]> {
    if (!hre.network.zksync) {
        return await runSuper();
    }

    const compilerVersions = hre.config.solidity.compilers.map((c) => c.version);
    if (hre.config.solidity.overrides !== undefined) {
        for (const { version } of Object.values(hre.config.solidity.overrides)) {
            compilerVersions.push(version);
        }
    }

    return compilerVersions;
}

export async function verifyContract(
    { address, contract: contractFQN, constructorArguments, libraries }: TaskArguments,
    hre: HardhatRuntimeEnvironment,
    runSuper: RunSuperFunction<TaskArguments>
): Promise<number> {
    if (!hre.network.zksync) {
        return await runSuper({ address, contractFQN, constructorArguments, libraries });
    }

    const { isAddress } = await import('@ethersproject/address');
    if (!isAddress(address)) {
        throw new ZkSyncVerifyPluginError(`${address} is an invalid address.`);
    }

    if (!Array.isArray(constructorArguments)) {
        throw new ZkSyncVerifyPluginError(CONST_ARGS_ARRAY_ERROR);
    }

    const deployedBytecodeHex = await retrieveContractBytecode(address, hre.network);
    const deployedBytecode = new Bytecode(deployedBytecodeHex);

    const compilerVersions: string[] = await hre.run(TASK_VERIFY_GET_COMPILER_VERSIONS);

    await hre.run(TASK_COMPILE);

    const contractInformation: ContractInformation = await hre.run(TASK_VERIFY_GET_CONTRACT_INFORMATION, {
        contractFQN: contractFQN,
        deployedBytecode: deployedBytecode,
        matchingCompilerVersions: compilerVersions,
        libraries: libraries,
    });

    const sourceName = contractInformation.sourceName;
    const contractName = contractInformation.contractName;

    const minimumBuild: Build = await hre.run(TASK_VERIFY_GET_MINIMUM_BUILD, {
        sourceName: sourceName,
    });

    const solcVersion = contractInformation.solcVersion;

    const deployArgumentsEncoded =
        '0x' +
        (await encodeArguments(minimumBuild.output.contracts[sourceName][contractName].abi, constructorArguments));

    const compilerPossibleVersions = await getSupportedCompilerVersions(hre.network.verifyURL);
    const compilerVersion: string = minimumBuild.output.version;
    if (!compilerPossibleVersions.includes(compilerVersion)) {
        throw new ZkSyncVerifyPluginError(COMPILER_VERSION_NOT_SUPPORTED);
    }
    const compilerZksolcVersion = 'v' + minimumBuild.output.zk_version;

    return await hre.run(TASK_VERIFY_VERIFY_MINIMUM_BUILD, {
        minimumBuild,
        contractInformation,
        address,
        compilerZksolcVersion,
        solcVersion,
        deployArgumentsEncoded,
    });
}

export async function verifyMinimumBuild(
    {
        minimumBuild,
        contractInformation,
        address,
        compilerZksolcVersion,
        solcVersion,
        deployArgumentsEncoded,
    }: TaskArguments,
    hre: HardhatRuntimeEnvironment
): Promise<number> {
    const minimumBuildContractBytecode =
        minimumBuild.output.contracts[contractInformation.sourceName][contractInformation.contractName].evm.bytecode
            .object;

    const matchedBytecode =
        contractInformation.compilerOutput.contracts[contractInformation.sourceName][contractInformation.contractName]
            .evm.bytecode.object;

    const dependencyGraph: DependencyGraph = await hre.run(TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH, {
        sourceNames: [contractInformation.sourceName],
    });

    contractInformation.contractName = contractInformation.sourceName + ':' + contractInformation.contractName;

    if (minimumBuildContractBytecode === matchedBytecode) {
        const request: ZkSyncBlockExplorerVerifyRequest = {
            contractAddress: address,
            sourceCode: getSolidityStandardJsonInput(hre, dependencyGraph.getResolvedFiles()),
            codeFormat: JSON_INPUT_CODE_FORMAT,
            contractName: contractInformation.contractName,
            compilerSolcVersion: solcVersion,
            compilerZksolcVersion: compilerZksolcVersion,
            constructorArguments: deployArgumentsEncoded,
            optimizationUsed: true,
        };

        const response = await verifyContractRequest(request, hre.network.verifyURL);
        const verificationId = parseInt(response.message);

        console.info(chalk.cyan('Your verification ID is: ' + verificationId));

        await hre.run(TASK_CHECK_VERIFICATION_STATUS, { verificationId: verificationId });

        return verificationId;
    }

    return UNSUCCESSFUL_VERIFICATION_ID;
}

export async function getContractInfo(
    { contractFQN, deployedBytecode, matchingCompilerVersions, libraries }: TaskArguments,
    { network, artifacts }: HardhatRuntimeEnvironment,
    runSuper: RunSuperFunction<TaskArguments>
): Promise<any> {
    if (!network.zksync) {
        return await runSuper({ contractFQN, deployedBytecode, matchingCompilerVersions, libraries });
    }

    let contractInformation;

    if (contractFQN !== undefined) {
        checkContractName(artifacts, contractFQN);

        // Process BuildInfo here to check version and throw an error if unexpected version is found.
        const buildInfo = await artifacts.getBuildInfo(contractFQN);

        if (buildInfo === undefined) {
            throw new ZkSyncVerifyPluginError(
                `We couldn't find the sources of your "${contractFQN}" contract in the project.
  Please make sure that it has been compiled by Hardhat and that it is written in Solidity.`
            );
        }

        const { sourceName, contractName } = parseFullyQualifiedName(contractFQN);
        contractInformation = await extractMatchingContractInformation(
            sourceName,
            contractName,
            buildInfo,
            deployedBytecode
        );

        if (contractInformation === null) {
            throw new ZkSyncVerifyPluginError(NO_MATCHING_CONTRACT);
        }
    } else {
        contractInformation = await inferContractArtifacts(artifacts, matchingCompilerVersions, deployedBytecode);
    }
    return contractInformation;
}

export async function checkVerificationStatus(args: { verificationId: number }, hre: HardhatRuntimeEnvironment) {
    let isValidVerification = await executeVeificationWithRetry(args.verificationId, hre.network.verifyURL);

    if (isValidVerification?.errorExists()) {
        throw new ZkSyncVerifyPluginError(isValidVerification.getError());
    }
    if (isValidVerification) console.info(chalk.green(`Contract successfully verified on zkSync block explorer!`));
}
