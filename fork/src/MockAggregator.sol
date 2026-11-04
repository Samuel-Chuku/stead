// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Settable Chainlink-style price source for the Q6 fork demo (8 decimals).
contract MockAggregator {
    int256 public latestAnswer;
    uint8 public constant decimals = 8;

    constructor(int256 a) { latestAnswer = a; }

    function setAnswer(int256 a) external { latestAnswer = a; }
}
