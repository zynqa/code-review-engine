<?php

declare(strict_types=1);

namespace Zynqa\Sniffs\Files;

use PHP_CodeSniffer\Files\File;
use PHP_CodeSniffer\Sniffs\Sniff;

class InstallSchemaUsageSniff implements Sniff
{
    public function register()
    {
        return [T_OPEN_TAG];
    }

    public function process(File $phpcsFile, $stackPtr)
    {
        $fileName = str_replace('\\', '/', $phpcsFile->getFilename());
        if (substr($fileName, -24) !== '/Setup/InstallSchema.php') {
            return;
        }

        $phpcsFile->addError(
            'Use declarative schema (db_schema.xml) instead of InstallSchema scripts.',
            $stackPtr,
            'DeprecatedInstallSchema'
        );
    }
}
