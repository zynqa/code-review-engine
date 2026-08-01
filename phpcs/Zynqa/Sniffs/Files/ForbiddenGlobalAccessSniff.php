<?php

declare(strict_types=1);

namespace Zynqa\Sniffs\Files;

use PHP_CodeSniffer\Files\File;
use PHP_CodeSniffer\Sniffs\Sniff;

class ForbiddenGlobalAccessSniff implements Sniff
{
    /**
     * Public so a ruleset can override the list per stack. The defaults below are the
     * Magento wording; phpcs/Laravel/ruleset.xml replaces them with Laravel equivalents.
     *
     * @var array<string, string>
     */
    public $forbiddenVariables = [
        '$_GET' => 'Use request abstractions instead of reading from $_GET directly.',
        '$_POST' => 'Use request abstractions instead of reading from $_POST directly.',
        '$_REQUEST' => 'Use request abstractions instead of reading from $_REQUEST directly.',
        '$_SERVER' => 'Use framework services instead of reading from $_SERVER directly.',
        '$_SESSION' => 'Use Magento session services instead of accessing $_SESSION directly.',
        '$GLOBALS' => 'Avoid accessing $GLOBALS directly.',
    ];

    public function register()
    {
        return [T_VARIABLE, T_GLOBAL];
    }

    public function process(File $phpcsFile, $stackPtr)
    {
        $tokens = $phpcsFile->getTokens();
        $content = $tokens[$stackPtr]['content'];

        if ($tokens[$stackPtr]['code'] === T_GLOBAL) {
            $phpcsFile->addError(
                'Avoid using the global keyword; inject dependencies or return state explicitly.',
                $stackPtr,
                'GlobalKeyword'
            );
            return;
        }

        if (!isset($this->forbiddenVariables[$content])) {
            return;
        }

        $phpcsFile->addError(
            $this->forbiddenVariables[$content],
            $stackPtr,
            'ForbiddenVariableAccess'
        );
    }
}
