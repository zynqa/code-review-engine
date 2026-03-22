<?php

class Zynqa_Sniffs_Files_StrictTypesDeclarationSniff implements PHP_CodeSniffer\Sniffs\Sniff
{
    public function register()
    {
        return [T_OPEN_TAG];
    }

    public function process(PHP_CodeSniffer\Files\File $phpcsFile, $stackPtr)
    {
        $fileName = str_replace('\\', '/', $phpcsFile->getFilename());
        if (substr($fileName, -4) !== '.php') {
            return;
        }

        $tokens = $phpcsFile->getTokens();
        $nextPtr = $phpcsFile->findNext(
            [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT_OPEN_TAG, T_DOC_COMMENT_CLOSE_TAG, T_DOC_COMMENT_STAR, T_DOC_COMMENT_STRING, T_DOC_COMMENT_TAG],
            $stackPtr + 1,
            null,
            true
        );

        if ($nextPtr === false || $tokens[$nextPtr]['code'] !== T_DECLARE) {
            $phpcsFile->addError(
                'PHP files must declare strict types with declare(strict_types=1); immediately after the opening tag.',
                $stackPtr,
                'MissingStrictTypesDeclaration'
            );
            return;
        }

        $declareStatement = $this->collectDeclareStatement($tokens, $nextPtr);
        if (!preg_match('/declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;/i', $declareStatement)) {
            $phpcsFile->addError(
                'PHP files must declare strict types with declare(strict_types=1); immediately after the opening tag.',
                $nextPtr,
                'InvalidStrictTypesDeclaration'
            );
        }
    }

    private function collectDeclareStatement(array $tokens, $declarePtr)
    {
        $parts = [];
        $count = count($tokens);

        for ($ptr = $declarePtr; $ptr < $count; $ptr++) {
            $parts[] = $tokens[$ptr]['content'];
            if ($tokens[$ptr]['code'] === T_SEMICOLON) {
                break;
            }
        }

        return implode('', $parts);
    }
}
