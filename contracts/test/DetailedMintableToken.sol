pragma solidity ^0.5.0;

import "@openzeppelin/contracts/token/ERC20/ERC20Detailed.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20Mintable.sol";

contract DetailedMintableToken is ERC20Mintable {
    uint8 private _decimals;
    string private _symbol;

    // Used to access number of decimals and be able mint
    constructor(string memory symbol, uint8 decimals) public {
        _symbol = symbol;
        _decimals = decimals;
    }

    function symbol() public view returns (string memory) {
        return _symbol;
    }

    function decimals() public view returns (uint8) {
        return _decimals;
    }
}
