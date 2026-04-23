<?php

declare(strict_types=1);

class Zynqa_Sniffs_Files_ObjectManagerUsageSniff implements PHP_CodeSniffer\Sniffs\Sniff
{
    private const TEST_PATH_SEGMENTS = [
        '/test/',
        '/tests/',
        '/dev/tests/',
    ];

    public function register()
    {
        return [T_STRING, T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED, T_VARIABLE];
    }

    public function process(PHP_CodeSniffer\Files\File $phpcsFile, $stackPtr)
    {
        if ($this->isTestFile($phpcsFile)) {
            return;
        }

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

    private function isTestFile(PHP_CodeSniffer\Files\File $phpcsFile): bool
    {
        $normalizedPath = str_replace('\\', '/', $phpcsFile->getFilename());
        $lowerPath = strtolower($normalizedPath);

        foreach (self::TEST_PATH_SEGMENTS as $segment) {
            if (strpos($lowerPath, $segment) !== false) {
                return true;
            }
        }

        return false;
    }
}
