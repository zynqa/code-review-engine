<?php

declare(strict_types=1);

class Zynqa_Sniffs_Files_ObjectManagerUsageSniff implements PHP_CodeSniffer\Sniffs\Sniff
{
    public function register()
    {
        return [T_STRING, T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED, T_VARIABLE];
    }

    public function process(PHP_CodeSniffer\Files\File $phpcsFile, $stackPtr)
    {
        $tokens = $phpcsFile->getTokens();
        $content = ltrim($tokens[$stackPtr]['content'], '\\');

        if ($tokens[$stackPtr]['code'] === T_VARIABLE && $tokens[$stackPtr]['content'] === '$objectManager') {
            $phpcsFile->addError(
                'Do not use ObjectManager directly; inject concrete dependencies instead.',
                $stackPtr,
                'ObjectManagerVariable'
            );
            return;
        }

        if (!in_array($content, ['Magento\Framework\App\ObjectManager', 'Magento\Framework\ObjectManagerInterface', 'ObjectManagerInterface'], true)) {
            return;
        }

        $phpcsFile->addError(
            'Do not use ObjectManager directly; inject concrete dependencies instead.',
            $stackPtr,
            'ObjectManagerUsage'
        );
    }
}
